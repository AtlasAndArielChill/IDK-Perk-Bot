const { Client, GatewayIntentBits, Partials, REST, Routes, AttachmentBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { commands } = require('./commands.js');
const { generateLeaderboardImage } = require('./imageGenerator.js');

// --- 1. Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Discord bot is running!');
});

app.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`);
});

// --- 2. Configuration & Data Storage ---
const XP_PER_MESSAGE = 100;
const CRATE_COST = 10000;
const LEADERBOARD_CHANNEL_ID = '1419661281434009610'; // PASTE YOUR CHANNEL ID HERE

let userData = {};
let leaderboardMessageId = null;

const dataFile = path.join(__dirname, 'data.json');

const PERK_LOOT_TABLE = [
    { name: "XP Boost (Silver)", type: "xp", boost: 0.05, roleName: null, weight: 50 },
    { name: "View Stock", type: "role", boost: 0, roleName: "Stock Viewer", weight: 25 },
    { name: "XP Boost (Gold)", type: "xp", boost: 0.10, roleName: null, weight: 12 },
    { name: "XP Boost (Rainbow)", type: "xp", boost: 0.20, roleName: null, weight: 9 },
    { name: "Shoutout", type: "role", boost: 0, roleName: "Shoutout", weight: 4 }
];

// --- 3. Helper Functions ---
function loadData() {
    try {
        if (fs.existsSync(dataFile)) {
            const fileContent = fs.readFileSync(dataFile, 'utf8');
            const loadedData = JSON.parse(fileContent);

            userData = loadedData.users || {};
            leaderboardMessageId = loadedData.leaderboardMessageId || null;
        }
    } catch (err) {
        console.error('Error loading data:', err);
    }
}

function saveData() {
    const dataToSave = {
        users: userData,
        leaderboardMessageId: leaderboardMessageId
    };
    fs.writeFileSync(dataFile, JSON.stringify(dataToSave, null, 4));
}

function getRandomPerk() {
    let totalWeight = PERK_LOOT_TABLE.reduce((sum, item) => sum + item.weight, 0);
    let randomNum = Math.random() * totalWeight;

    for (const item of PERK_LOOT_TABLE) {
        if (randomNum < item.weight) {
            return item;
        }
        randomNum -= item.weight;
    }
}

function calculateTotalXpBoost(perks) {
    let totalBoost = 1;
    perks.forEach(perk => {
        if (perk.type === "xp") {
            totalBoost += perk.boost;
        }
    });
    return totalBoost;
}

async function updateLeaderboardChannel() {
    const channel = client.channels.cache.get(LEADERBOARD_CHANNEL_ID);
    if (!channel) return console.error("Leaderboard channel not found!");

    const sortedXpUsers = Object.entries(userData).sort(([, a], [, b]) => b.xp - a.xp);

    const topXpUsers = await Promise.all(sortedXpUsers.slice(0, 10).map(async ([userId, user]) => {
        try {
            const discordUser = await client.users.fetch(userId);
            return {
                name: discordUser.username,
                value: user.xp,
                avatarUrl: discordUser.displayAvatarURL({ extension: 'png' })
            };
        } catch (error) {
            return {
                name: 'Unknown User',
                value: user.xp,
                avatarUrl: null
            };
        }
    }));

    await generateLeaderboardImage("Top 10 XP Leaderboard", topXpUsers, "XP");
    const xpImage = new AttachmentBuilder('leaderboard.png');

    if (leaderboardMessageId) {
        try {
            const message = await channel.messages.fetch(leaderboardMessageId);
            await message.edit({ content: "", files: [xpImage] });
            console.log("Leaderboard updated!");
        } catch (error) {
            console.error("Failed to edit leaderboard message, sending a new one.", error);
            const newMessage = await channel.send({ content: "Here's the new leaderboard:", files: [xpImage] });
            leaderboardMessageId = newMessage.id;
            saveData();
        }
    } else {
        const newMessage = await channel.send({ content: "Here's the current leaderboard:", files: [xpImage] });
        leaderboardMessageId = newMessage.id;
        saveData();
        console.log("New leaderboard message sent!");
    }
}

// --- 4. Client & Event Handling ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
});

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    loadData();
    client.user.setActivity('for messages', { type: 'WATCHING' });

    // --- New Code to update nicknames on startup ---
    const guild = client.guilds.cache.get('YOUR_GUILD_ID'); // Replace with your guild ID
    if (guild) {
        for (const userId in userData) {
            const user = userData[userId];
            if (user.perks.length > 0) {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    const latestPerk = user.perks[user.perks.length - 1]; // Get the most recent perk
                    const currentName = member.displayName.split('(')[0].trim();
                    const newNickname = `${currentName} (${latestPerk.name})`;
                    if (member.nickname !== newNickname) {
                        try {
                            await member.setNickname(newNickname, "Updating nickname from startup check");
                        } catch (error) {
                            console.error(`Failed to set nickname for ${member.user.tag}:`, error);
                        }
                    }
                }
            }
        }
    }
    // --- End of new code ---

    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
        await updateLeaderboardChannel();
    } catch (error) {
        console.error(error);
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const userId = message.author.id;
    if (!userData[userId]) {
        userData[userId] = { xp: 0, perks: [] };
    }

    const xpBoost = calculateTotalXpBoost(userData[userId].perks);
    const xpGained = Math.floor(XP_PER_MESSAGE * xpBoost);
    userData[userId].xp += xpGained;
    saveData();
    
    await updateLeaderboardChannel();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const commandName = interaction.commandName;
    const userId = interaction.user.id;
    
    if (!userData[userId]) {
        userData[userId] = { xp: 0, perks: [] };
    }
    const user = userData[userId];

    switch (commandName) {
        case 'buycrate':
            await interaction.deferReply({ ephemeral: true });
            if (user.xp >= CRATE_COST) {
                user.xp -= CRATE_COST;
                const newPerk = getRandomPerk();
                user.perks.push(newPerk);
                saveData();

                // Get the member and their current display name
                const member = interaction.member;
                const currentName = member.displayName.split('(')[0].trim();

                // Create the new nickname with the new perk
                const newNickname = `${currentName} (${newPerk.name})`;

                // Set the nickname, checking for permissions
                try {
                    await member.setNickname(newNickname, "Applying new perk nickname");
                } catch (error) {
                    console.error(`Failed to set nickname for ${member.user.tag}:`, error);
                }

                let replyMessage = `Congratulations, **${interaction.user.username}**! You bought a perk crate and received the **${newPerk.name}**!`;

                if (newPerk.type === "role" && newPerk.roleName) {
                    const role = interaction.guild.roles.cache.find(r => r.name === newPerk.roleName);
                    if (role) {
                        await member.roles.add(role);
                        replyMessage += `\n You have been given the **${role.name}** role.`;
                    } else {
                        replyMessage += `\n (Warning: The role "${newPerk.roleName}" was not found.)`;
                    }
                } else if (newPerk.type === "xp") {
                    replyMessage += `\n This gives you a permanent **+${(newPerk.boost * 100).toFixed(0)}%** XP boost.`;
                }
                
                await interaction.editReply(replyMessage);
                await updateLeaderboardChannel();
            } else {
                const remaining = CRATE_COST - user.xp;
                await interaction.editReply(`You need **${remaining}** more XP to buy a perk crate.`);
            }
            break;

        case 'givexp':
            await interaction.deferReply({ ephemeral: true });

            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.editReply({ content: "You do not have permission to use this command." });
            }

            const targetUser = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');

            if (amount <= 0) {
                return interaction.editReply({ content: "The amount of XP must be a positive number." });
            }
            
            const targetUserId = targetUser.id;
            if (!userData[targetUserId]) {
                userData[targetUserId] = { xp: 0, perks: [] };
            }
            
            userData[targetUserId].xp += amount;
            saveData();
            
            await interaction.editReply({ 
                content: `Gave **${amount}** XP to **${targetUser.username}**!`
            });

            await updateLeaderboardChannel();
            break;

        case 'leaderboardxp':
        case 'leaderboardperks':
            const leaderboardChannel = client.channels.cache.get(LEADERBOARD_CHANNEL_ID);
            if (!leaderboardChannel) {
                return interaction.reply({ content: "The leaderboard channel is not configured correctly. Please contact an admin.", ephemeral: true });
            }
            await interaction.reply({ content: `Check the dedicated leaderboard channel (<#${LEADERBOARD_CHANNEL_ID}>) for the latest leaderboard!`, ephemeral: true });
            break;
            
        case 'myinfo':
            if (user.xp !== undefined) {
                const xpBoost = calculateTotalXpBoost(user.perks) - 1;
                const perksList = user.perks.length > 0 ? user.perks.map(p => `• ${p.name}`).join('\n') : "You have no perks yet.";
                
                await interaction.reply({
                    content: `**${interaction.user.username}'s Stats**\nXP: ${user.xp}\nXP Boost: +${(xpBoost * 100).toFixed(0)}%\n\n**Perks:**\n${perksList}`,
                    ephemeral: true
                });
            } else {
                await interaction.reply({ content: "You have no stats yet. Start sending messages to gain XP!", ephemeral: true });
            }
            break;
    }
});

client.login(process.env.TOKEN);
