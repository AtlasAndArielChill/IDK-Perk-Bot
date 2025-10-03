// index.js

const { 
    Client, GatewayIntentBits, Partials, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType 
} = require('discord.js');
const Database = require('better-sqlite3');
const { registerFont, createCanvas, loadImage } = require('@napi-rs/canvas'); 
const express = require('express'); // ADDED: Express for web server
require('dotenv').config(); 

// --- Configuration ---
const XP_PER_MESSAGE = 100;
const CRATE_COST = 10000;
const INTERVAL_MS = 60000; // 1 minute
const GIVE_XP_COOLDOWN_MS = 120000; // 2 minutes (2 * 60 * 1000 ms)
// Setting a large but realistic max amount. We use BigInt now, so overflow shouldn't happen, 
// but this protects against excessively large user input.
const MAX_GIVE_XP_AMOUNT = 1000000000; // Maximum 1 billion XP per command execution
const PORT = process.env.PORT || 3000; // ADDED: Define port for the web server

// Load IDs from environment variables
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const VIEW_STOCK_ROLE_ID = process.env.VIEW_STOCK_ROLE_ID; 
const SHOUTOUT_ROLE_ID = process.env.SHOUTOUT_ROLE_ID;

if (!DISCORD_BOT_TOKEN || !LEADERBOARD_CHANNEL_ID || !VIEW_STOCK_ROLE_ID || !SHOUTOUT_ROLE_ID) {
    console.error("FATAL ERROR: Missing one or more required environment variables (TOKEN, CHANNEL_ID, ROLE_IDs). Check your .env file.");
    process.exit(1);
}

// Perk Chances and Effects (Based on provided image percentages)
const PERKS = {
    "Silver XP Boost":     { chance: 50, effect: { type: 'xp_boost', value: 0.05 } },
    "View Stock (Role)":   { chance: 25, effect: { type: 'role', roleId: VIEW_STOCK_ROLE_ID } }, 
    "Gold XP Boost":       { chance: 12, effect: { type: 'xp_boost', value: 0.10 } },
    "Rainbow XP Boost":    { chance: 9, effect: { type: 'xp_boost', value: 0.20 } },
    "Shoutout (Role)":     { chance: 4, effect: { type: 'role', roleId: SHOUTOUT_ROLE_ID } }, 
};

// --- In-Memory Cooldown Storage ---
const cooldowns = new Map();

// --- Database Setup (better-sqlite3) ---

const db = new Database('xp.sqlite');

// Configure better-sqlite3 to return BigInt for large numbers (especially when using TEXT for storage)
// This ensures that the XP value is always treated as a BigInt in JavaScript.
db.pragma('journal_mode = WAL');

// Initialize the database tables. XP is now stored as TEXT to reliably handle BigInt.
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        xp TEXT DEFAULT '0',  -- Changed to TEXT to safely store large numbers as BigInt
        crates INTEGER DEFAULT 0,
        current_perk TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS perks (
        name TEXT PRIMARY KEY,
        obtained INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// --- MIGRATION: Safely add new columns for existing DB files ---
try {
    db.exec(`ALTER TABLE users ADD COLUMN crates INTEGER DEFAULT 0`);
} catch (e) {
    if (!e.message.includes('duplicate column name')) {
        console.error("Migration Error adding 'crates':", e);
    }
}
try {
    db.exec(`ALTER TABLE users ADD COLUMN current_perk TEXT DEFAULT NULL`);
} catch (e) {
    if (!e.message.includes('duplicate column name')) {
        console.error("Migration Error adding 'current_perk':", e);
    }
}


// Initialize perk counts if not present
const insertPerkStmt = db.prepare('INSERT OR IGNORE INTO perks (name) VALUES (?)');
Object.keys(PERKS).forEach(perkName => insertPerkStmt.run(perkName));


// --- Helper Functions (Database & Perk Logic) ---

/**
 * Retrieves user data, ensuring XP is handled as BigInt for safety.
 * IMPORTANT: This function ensures a user exists in the database.
 * @param {string} userId 
 * @returns {{xp: BigInt, crates: number, current_perk: string | null}}
 */
function getUserData(userId) {
    const row = db.prepare('SELECT xp, crates, current_perk FROM users WHERE id = ?').get(userId);
    
    if (!row) {
        db.prepare('INSERT OR IGNORE INTO users (id, xp, crates, current_perk) VALUES (?, ?, 0, NULL)').run(userId, '0');
        // Now fetch the data after insertion to get the default values
        const newRow = db.prepare('SELECT xp, crates, current_perk FROM users WHERE id = ?').get(userId);
        const xpAsBigInt = BigInt(newRow.xp || '0');
        return { 
            ...newRow, 
            xp: xpAsBigInt 
        };
    }
    
    // XP is stored as TEXT, convert it to BigInt in JS
    const xpAsBigInt = BigInt(row.xp || '0');
    
    return { 
        ...row, 
        xp: xpAsBigInt // Return XP as BigInt
    };
}

/**
 * Gets just the user's XP as BigInt.
 * NOTE: This function does NOT create a user if they don't exist.
 * @param {string} userId 
 * @returns {BigInt}
 */
function getUserXP(userId) {
    const row = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
    return row ? BigInt(row.xp || '0') : 0n;
}

/**
 * Adds or subtracts XP, performing all math with BigInt and storing as TEXT.
 * NOTE: This function assumes the user already exists in the database.
 * @param {string} userId 
 * @param {number} amount 
 */
function addXP(userId, amount) {
    // 1. Get current XP as BigInt
    const currentXP = getUserXP(userId);
    // 2. Convert the incoming amount to BigInt
    const amountBigInt = BigInt(amount);
    // 3. Perform the calculation with BigInt
    const newXP = currentXP + amountBigInt;
    
    // 4. Store the result back as a TEXT string
    // This will only work if the user row exists. For new users, getUserData must be called first.
    db.prepare('UPDATE users SET xp = ? WHERE id = ?').run(newXP.toString(), userId);
}

function addCrates(userId, amount) {
    db.prepare('UPDATE users SET crates = crates + ? WHERE id = ?').run(amount, userId);
}

/**
 * Removes the user's currently active perk (and associated role, if applicable).
 * @param {GuildMember} member - The Discord guild member object.
 * @returns {Promise<void>}
 */
async function removeUserPerk(member) {
    const { current_perk } = getUserData(member.id);
    if (!current_perk) return;

    const perkData = PERKS[current_perk];
    if (!perkData) return;

    if (perkData.effect.type === 'role') {
        try {
            if (member.roles.cache.has(perkData.effect.roleId)) {
                await member.roles.remove(perkData.effect.roleId);
            }
        } catch (error) {
            console.error(`Failed to remove old role ${perkData.effect.roleId}:`, error);
        }
    }
    
    db.prepare('UPDATE users SET current_perk = NULL WHERE id = ?').run(member.id);
}

/**
 * Equips a new perk for the user, managing role changes and DB state.
 * @param {GuildMember} member - The Discord guild member object.
 * @param {string} perkName - The name of the new perk to equip.
 * @returns {Promise<void>}
 */
async function equipNewPerk(member, perkName) {
    // 1. Remove old perk and roles first
    await removeUserPerk(member);

    // 2. Equip new perk
    db.prepare('UPDATE users SET current_perk = ? WHERE id = ?').run(perkName, member.id);
    
    const newPerkData = PERKS[perkName];
    if (newPerkData.effect.type === 'role') {
        try {
            await member.roles.add(newPerkData.effect.roleId);
        } catch (error) {
            console.error(`Failed to grant new role ${newPerkData.effect.roleId}:`, error);
        }
    }
}

function getRandomPerk() {
    const totalChance = Object.values(PERKS).reduce((sum, perk) => sum + perk.chance, 0);
    let rand = Math.random() * totalChance;

    for (const [name, data] of Object.entries(PERKS)) {
        if (rand < data.chance) {
            db.prepare('UPDATE perks SET obtained = obtained + 1 WHERE name = ?').run(name);
            return { name, data };
        }
        rand -= data.chance;
    }
    const fallbackName = Object.keys(PERKS)[0];
    db.prepare('UPDATE perks SET obtained = obtained + 1 WHERE name = ?').run(fallbackName);
    return { name: fallbackName, data: PERKS[fallbackName] };
}

function getLastLeaderboardMessageId() {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('leaderboard_message_id');
    return row ? row.value : null;
}

function setLastLeaderboardMessageId(messageId) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('leaderboard_message_id', messageId);
}


// --- Image Generation (Canvas Functions) ---

async function createXPLeaderboardImage(topUsers, client) {
    const AVATAR_SIZE = 40; 
    const PADDING_LEFT = 20; 
    const NAME_START_X = PADDING_LEFT + AVATAR_SIZE + 10; 
    const XP_TEXT_RIGHT_PADDING = 20; 

    const width = 650; 
    const height = 80 + topUsers.length * 60;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#2C2F33'; 
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🏆 Top XP Earners 🏆', width / 2, 50);

    ctx.textAlign = 'left';

    for (let i = 0; i < topUsers.length; i++) {
        const user = topUsers[i];
        // Ensure user.xp is converted to BigInt for sorting safety, then to string for display
        const userXP = BigInt(user.xp || '0'); 
        const discordUser = await client.users.fetch(user.id).catch(() => null);
        const name = discordUser ? discordUser.username : `User ID: ${user.id}`;
        const rank = i + 1;

        const y = 100 + i * 60; 
        const textY = y + AVATAR_SIZE / 2 - 5; 

        ctx.fillStyle = i % 2 === 0 ? '#36393F' : '#40444B';
        ctx.fillRect(0, y - AVATAR_SIZE / 2 - 5, width, AVATAR_SIZE + 10);

        if (discordUser && discordUser.avatarURL()) {
            try {
                const avatar = await loadImage(discordUser.displayAvatarURL({ extension: 'png', size: 128 }));
                ctx.save();
                ctx.beginPath();
                ctx.arc(PADDING_LEFT + AVATAR_SIZE / 2, y + AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2, true);
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(avatar, PADDING_LEFT, y, AVATAR_SIZE, AVATAR_SIZE); 
                ctx.restore();
            } catch (error) {
                console.error(`Failed to load avatar for ${name}:`, error);
                ctx.fillStyle = '#7289DA';
                ctx.fillRect(PADDING_LEFT, y, AVATAR_SIZE, AVATAR_SIZE);
            }
        } else {
            ctx.fillStyle = '#7289DA'; 
            ctx.fillRect(PADDING_LEFT, y, AVATAR_SIZE, AVATAR_SIZE);
        }

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '24px sans-serif';
        ctx.fillText(`${rank}. ${name}`, NAME_START_X, textY);

        ctx.textAlign = 'right';
        ctx.fillStyle = '#7289DA'; 
        ctx.font = 'bold 24px sans-serif';
        // Use .toLocaleString() on the BigInt for proper comma formatting
        ctx.fillText(`${userXP.toLocaleString()} XP`, width - XP_TEXT_RIGHT_PADDING, textY);
        ctx.textAlign = 'left'; 
    }

    const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'xp-leaderboard.png' });
    return attachment;
}

function createPerkLeaderboardImage(topPerks) {
    const width = 650;
    const height = 80 + topPerks.length * 60;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#2C2F33';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('💎 Top Perks Obtained 💎', width / 2, 50);

    ctx.font = '24px sans-serif';
    ctx.textAlign = 'left';

    for (let i = 0; i < topPerks.length; i++) {
        const perk = topPerks[i];
        const rank = i + 1;
        const y = 100 + i * 60;
        
        ctx.fillStyle = i % 2 === 0 ? '#36393F' : '#40444B';
        ctx.fillRect(0, y - 30, width, 50);

        ctx.fillStyle = '#3CB371'; 
        ctx.font = 'bold 28px sans-serif';
        ctx.fillText(`#${rank}`, 20, y);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '24px sans-serif';
        ctx.fillText(perk.name, 100, y);

        ctx.textAlign = 'right';
        ctx.fillStyle = '#FFA07A'; 
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText(`${perk.obtained.toLocaleString()} times`, width - 20, y);
        ctx.textAlign = 'left'; 
    }

    const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'perk-leaderboard.png' });
    return attachment;
}


// --- Automated Leaderboard Sender (XP ONLY) ---

async function autoSendLeaderboards(client) {
    const channel = client.channels.cache.get(LEADERBOARD_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
        console.error(`ERROR: Leaderboard channel ID ${LEADERBOARD_CHANNEL_ID} is invalid or not a text channel.`);
        return;
    }

    try {
        // Select XP and order them. 
        const topUsers = db.prepare('SELECT id, xp FROM users ORDER BY CAST(xp AS REAL) DESC LIMIT 10').all();
        
        if (topUsers.length === 0) {
            return console.log('Skipping leaderboard update: No XP data to display.');
        }

        const xpAttachment = await createXPLeaderboardImage(topUsers, client); 
        const filesToSend = [xpAttachment];
        
        // Removed the timestamp and update interval text as requested by the user.
        const content = `📈 **LIVE XP LEADERBOARD** 📈\n\n`;

        const lastMessageId = getLastLeaderboardMessageId();
        let leaderboardMessage;

        if (lastMessageId) {
            try {
                leaderboardMessage = await channel.messages.fetch(lastMessageId);
                await leaderboardMessage.edit({ content: content, files: filesToSend, embeds: [], components: [] });
                console.log(`Successfully EDITED leaderboard message ID: ${lastMessageId}`);

            } catch (error) {
                console.log(`Could not find or edit message ID ${lastMessageId}. Sending new message.`);
                leaderboardMessage = await channel.send({ content: content, files: filesToSend });
                setLastLeaderboardMessageId(leaderboardMessage.id);
            }
        } else {
            leaderboardMessage = await channel.send({ content: content, files: filesToSend });
            setLastLeaderboardMessageId(leaderboardMessage.id);
            console.log(`Successfully SENT initial leaderboard message ID: ${leaderboardMessage.id}`);
        }
        
    } catch (error) {
        console.error('Fatal error during automatic leaderboard update:', error);
    }
}


// --- Discord Bot Client ---

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers, 
    ],
    partials: [Partials.Channel, Partials.GuildMember],
});

client.once('ready', async () => {
    console.log(`Bot is online! Logged in as ${client.user.tag}`);

    const commands = [
        new SlashCommandBuilder()
            .setName('buycrate')
            .setDescription('Buy perk crates for the cost of 10,000 XP each.')
            .addIntegerOption(option => 
                option.setName('amount')
                    .setDescription('The number of crates to purchase (min 1).')
                    .setRequired(true)
                    .setMinValue(1)), 
        
        new SlashCommandBuilder()
            .setName('opencrate')
            .setDescription('Open one of your purchased perk crates and equip the new perk. (1 crate max)'),

        new SlashCommandBuilder()
            .setName('givexp')
            .setDescription('Give XP to a user (2 minute cooldown).')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('The user to give XP to.')
                    .setRequired(true))
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription(`The amount of XP to give (Max ${MAX_GIVE_XP_AMOUNT.toLocaleString()}).`)
                    .setRequired(true)
                    .setMaxValue(MAX_GIVE_XP_AMOUNT) // Set max value here!
                    .setMinValue(1)),

        new SlashCommandBuilder()
            .setName('myinfo')
            .setDescription('Shows your current XP, crates, and equipped perk.'),

        new SlashCommandBuilder()
            .setName('leaderboard')
            .setDescription('Manually updates the live XP leaderboard.'),
            
        new SlashCommandBuilder()
            .setName('perkboard')
            .setDescription('Shows the Perk leaderboard as a temporary message.'),
            
        new SlashCommandBuilder() 
            .setName('resetallboards')
            .setDescription('[MOD ONLY] Resets all user XP, crate, and perk board data.'),
            
    ].map(command => command.toJSON());

    await client.application.commands.set(commands);
    console.log('Slash commands registered.');

    await new Promise(resolve => setTimeout(resolve, 5000));
    
    await autoSendLeaderboards(client); 
    
    setInterval(() => {
        autoSendLeaderboards(client);
    }, INTERVAL_MS);

    console.log(`Automatic leaderboard updates started. Interval: ${INTERVAL_MS / 60000} minute(s).`);
});

client.on('messageCreate', (message) => {
    if (message.author.bot || !message.content || !message.guild) return;
    // Ensure user exists before adding XP on every message
    getUserData(message.author.id); 
    addXP(message.author.id, XP_PER_MESSAGE);
});


// --- Interaction Handler for Slash Commands and Buttons ---

client.on('interactionCreate', async (interaction) => {
    if (interaction.isCommand()) {
        const { commandName } = interaction;
        const userId = interaction.user.id;
        const userData = getUserData(userId); 
        
        // --- /BUYCRATE (Purchase Initiation) ---
        if (commandName === 'buycrate') {
            const amount = interaction.options.getInteger('amount');
            // Since CRATE_COST is small, we can use standard multiplication for cost, 
            // but compare it against the BigInt XP
            const cost = amount * CRATE_COST; 
            const costBigInt = BigInt(cost);

            if (userData.xp < costBigInt) {
                return interaction.reply({
                    content: `❌ You need **${costBigInt.toLocaleString()} XP** to buy ${amount} crate(s), but you only have **${userData.xp.toLocaleString()} XP**!`,
                    ephemeral: true
                });
            }

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`CONFIRM_BUY_CRATE_${amount}`) 
                        .setLabel(`Confirm Purchase for ${costBigInt.toLocaleString()} XP`)
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('CANCEL_BUY_CRATE')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Secondary),
                );

            await interaction.reply({ 
                content: `⚠️ **Confirmation Required:** Do you want to spend **${costBigInt.toLocaleString()} XP** to buy **${amount}** Perk Crate(s)?`,
                components: [row],
                ephemeral: true 
            });

        // --- /OPENCRATE (Open and Equip) ---
        } else if (commandName === 'opencrate') {
            if (userData.crates < 1) {
                return interaction.reply({
                    content: `❌ You don't have any unopened crates! Buy one using \`/buycrate\`.`,
                    ephemeral: true
                });
            }

            const { name: newPerkName } = getRandomPerk();

            const isFirstTime = !userData.current_perk; 

            const encodedPerkName = newPerkName.replace(/[^a-zA-Z0-9]/g, '_'); 
            
            const equipButton = new ButtonBuilder()
                .setCustomId(`EQUIP_PERK_${encodedPerkName}`)
                .setLabel(`Equip ${newPerkName}`)
                .setStyle(ButtonStyle.Success);

            const keepButton = new ButtonBuilder()
                .setCustomId('KEEP_OLD_PERK')
                .setLabel(isFirstTime ? 'Skip Perk' : 'Keep Old Perk') // Dynamic label
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(equipButton, keepButton);
            
            addCrates(userId, -1);
            
            const equipEmbed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle(`✨ Crate Opened! You received: ${newPerkName}`)
                .setDescription(
                    `You have opened one crate. You have **${userData.crates - 1}** remaining. \n\n` +
                    `Your current equipped perk is: **${userData.current_perk || 'None'}**.\n\n` +
                    (isFirstTime 
                        ? `**INFO:** Since you have no active perk, choosing "Skip Perk" will just keep you perk-less.`
                        : `**WARNING:** Equipping this new perk will **unequip** your current one, and remove any associated role/boost.`)
                )
                .setFooter({ text: `Choose wisely! The perk will be equipped immediately upon confirmation.` });

            await interaction.reply({ embeds: [equipEmbed], components: [row], ephemeral: true });


        // --- /GIVEXP (Anyone can use, 2 min cooldown) ---
        } else if (commandName === 'givexp') {
            const giver = interaction.user;
            const recipient = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');
            
            // Re-check the maximum amount just in case the user bypassed Discord's input field limit
            if (amount > MAX_GIVE_XP_AMOUNT) {
                 return interaction.reply({ content: `❌ The maximum XP you can give at once is **${MAX_GIVE_XP_AMOUNT.toLocaleString()}**.`, ephemeral: true });
            }

            // Rate Limit Check
            const lastUsed = cooldowns.get(userId);
            if (lastUsed) {
                const timeSinceLastUse = Date.now() - lastUsed;
                const timeLeft = GIVE_XP_COOLDOWN_MS - timeSinceLastUse;

                if (timeLeft > 0) {
                    const minutes = Math.floor(timeLeft / 60000);
                    const seconds = Math.floor((timeLeft % 60000) / 1000);
                    
                    return interaction.reply({ 
                        content: `⏳ You are on cooldown! Wait **${minutes}m ${seconds}s** before giving XP again.`, 
                        ephemeral: true 
                    });
                }
            }
            
            if (amount <= 0) {
                 return interaction.reply({ content: '❌ You must give a positive amount of XP.', ephemeral: true });
            }
            
            // --- NEW: Confirmation Step before execution and cooldown ---
            const amountBigInt = BigInt(amount);
            
            const row = new ActionRowBuilder()
                .addComponents(
                    // Pass recipient ID and amount in customId for button handler
                    new ButtonBuilder()
                        .setCustomId(`CONFIRM_GIVEXP_${recipient.id}_${amount}`) 
                        .setLabel(`Confirm Give ${amountBigInt.toLocaleString()} XP`)
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('CANCEL_GIVEXP')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Secondary),
                );

            await interaction.reply({
                content: `⚠️ **Confirmation Required:** Are you sure you want to give **${amountBigInt.toLocaleString()} XP** to ${recipient}? This will start your 2-minute cooldown.`,
                components: [row],
                ephemeral: true
            });


        // --- /MYINFO (Show status) ---
        } else if (commandName === 'myinfo') {
            const xp = userData.xp; // This is a BigInt now
            const xpNeeded = BigInt(CRATE_COST) - (xp % BigInt(CRATE_COST));
            
            const myInfoEmbed = new EmbedBuilder()
                .setColor('#57F287')
                .setTitle(`👤 ${interaction.user.username}'s Status`)
                .setDescription(
                    `**Current XP:** ${xp.toLocaleString()} XP\n` +
                    `**Unopened Crates:** ${userData.crates.toLocaleString()} 📦\n` +
                    `**Equipped Perk:** ${userData.current_perk || 'None'} 💎`
                )
                .addFields({ 
                    name: 'Next Crate Progress', 
                    value: `You need **${xpNeeded.toLocaleString()} XP** to buy your next crate.`,
                    inline: true
                })
                .setFooter({ text: `Perk Crate Cost: ${CRATE_COST} XP | Use /opencrate to open.` });

            await interaction.reply({ embeds: [myInfoEmbed], ephemeral: true });
            
        // --- /LEADERBOARD & /PERKBOARD ---
        } else if (commandName === 'leaderboard') {
            await interaction.deferReply({ ephemeral: true });
            await autoSendLeaderboards(client);
            await interaction.editReply({ 
                content: `✅ The **XP Leaderboard** has been manually triggered to update in <#${LEADERBOARD_CHANNEL_ID}>!`
            });
        } else if (commandName === 'perkboard') {
            await interaction.deferReply(); 
            const topPerks = db.prepare('SELECT name, obtained FROM perks ORDER BY obtained DESC LIMIT 10').all();
            if (topPerks.length === 0) return interaction.editReply('No perks have been obtained yet!');
            const perkAttachment = createPerkLeaderboardImage(topPerks);
            await interaction.editReply({ 
                content: `💎 **Perk Board (Most Obtained Perks)** 💎`,
                files: [perkAttachment]
            });
        
        // --- /RESETALLBOARDS (Admin/Mod Command with Confirmation) ---
        } else if (commandName === 'resetallboards') {
            const resetRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('CONFIRM_RESET_ALL')
                        .setLabel('CONFIRM: Reset All Data')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('CANCEL_RESET_ALL')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Secondary),
                );

            await interaction.reply({
                content: '🛑 **DANGER ZONE: ARE YOU SURE?** This action will permanently delete ALL user XP data and reset ALL perk counts. This is irreversible.',
                components: [resetRow],
                ephemeral: true
            });
        }
    } 
    
    // --- Button Interaction Handler ---
    else if (interaction.isButton()) {
        await interaction.deferUpdate(); 
        const customId = interaction.customId;
        const userId = interaction.user.id;
        const member = interaction.member;

        // --- 1. CONFIRM BUY CRATE (Handles Bulk Buy) ---
        if (customId.startsWith('CONFIRM_BUY_CRATE_')) {
            const amount = parseInt(customId.split('_')[3]); 
            const cost = amount * CRATE_COST;
            const costBigInt = BigInt(cost);
            const userData = getUserData(userId);
            
            if (userData.xp < costBigInt) {
                 return interaction.editReply({ content: '❌ Transaction failed: You no longer have enough XP!', components: [] });
            }

            // The negative amount will correctly subtract XP via the BigInt logic in addXP
            addXP(userId, -cost); 
            addCrates(userId, amount); 
            
            const newUserData = getUserData(userId);

            await interaction.editReply({ 
                content: `✅ Purchase Complete! You spent **${costBigInt.toLocaleString()} XP** and received **${amount}** Crate(s). 
                \nYour new XP: **${newUserData.xp.toLocaleString()}** | Total Crates: **${newUserData.crates}**\n\n` +
                `Use \`/opencrate\` to open them!`, 
                components: [] 
            });
            
        } else if (customId === 'CANCEL_BUY_CRATE') {
             await interaction.editReply({ content: '✅ Purchase cancelled.', components: [] });
             
        // --- 2. CONFIRM GIVE XP / CANCEL GIVE XP ---
        } else if (customId.startsWith('CONFIRM_GIVEXP_')) {
            const parts = customId.split('_');
            const recipientId = parts[2];
            const amount = parseInt(parts[3]);
            
            const recipient = await client.users.fetch(recipientId).catch(() => null);

            if (!recipient) {
                 return interaction.editReply({ content: '❌ Error: Could not find recipient user.', components: [] });
            }

            // Final check on cooldown before transaction (good for preventing double-spends)
            const lastUsed = cooldowns.get(userId);
            if (lastUsed && (Date.now() - lastUsed) < GIVE_XP_COOLDOWN_MS) {
                 return interaction.editReply({ content: '❌ Transaction failed: You are still on cooldown!', components: [] });
            }

            // Ensures the recipient user is initialized in the database if they are brand new.
            getUserData(recipient.id); 
            
            // Execute transaction and set cooldown
            addXP(recipient.id, amount);
            cooldowns.set(userId, Date.now()); 

            await interaction.editReply({
                content: `🎉 **Success!** You gave **${BigInt(amount).toLocaleString()} XP** to ${recipient.username}. They now have **${getUserXP(recipient.id).toLocaleString()} XP**.`,
                components: []
            });
        
        } else if (customId === 'CANCEL_GIVEXP') {
            await interaction.editReply({ content: '✅ XP transfer cancelled.', components: [] });
             
        // --- 3. EQUIP PERK / KEEP OLD PERK / SKIP PERK ---
        } else if (customId.startsWith('EQUIP_PERK_')) {
            const newPerkNameEncoded = customId.replace('EQUIP_PERK_', '');
            const newPerkName = Object.keys(PERKS).find(key => key.replace(/[^a-zA-Z0-9]/g, '_') === newPerkNameEncoded);
            
            if (!newPerkName) {
                return interaction.editReply({ content: '❌ Error: Could not identify perk. Please try opening a new crate.', components: [] });
            }

            await equipNewPerk(member, newPerkName);

            await interaction.editReply({ 
                content: `✨ **Perk Equipped!** You are now using: **${newPerkName}**. 
                \nYour previous perk (and any associated role/boost) has been removed.`,
                components: []
            });

        } else if (customId === 'KEEP_OLD_PERK') {
            await interaction.editReply({ 
                content: `✅ Okay! You kept your current equipped perk/skipped equipping the new one. The opened crate has been consumed.`, 
                components: [] 
            });

        // --- 4. CONFIRM/CANCEL RESET ALL BOARDS ---
        } else if (customId === 'CONFIRM_RESET_ALL') {
            try {
                // Deleting all user data effectively resets the XP
                db.exec('DELETE FROM users');
                db.exec('UPDATE perks SET obtained = 0');
                
                await interaction.editReply({ 
                    content: '✅ **SUCCESS:** All user XP and crate data has been wiped, and the Perk Board has been reset.', 
                    components: [] 
                });
                await autoSendLeaderboards(client);
            } catch (error) {
                console.error("Error during full reset:", error);
                await interaction.editReply({ 
                    content: '❌ An error occurred during the database reset.', 
                    components: [] 
                });
            }
        } else if (customId === 'CANCEL_RESET_ALL') {
             await interaction.editReply({ content: '✅ Reset cancelled. Data is safe.', components: [] });
        }
    }
});

// Log in to Discord
client.login(DISCORD_BOT_TOKEN);


// --- Express Server Setup ---
const app = express();

// Basic route for health checks
app.get('/', (req, res) => {
    res.status(200).send('Discord Bot Server is running and operational.');
});

app.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`);
});
