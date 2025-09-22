const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('buycrate')
    .setDescription('Spends 10000 XP to get a random perk!'),
  
  new SlashCommandBuilder()
    .setName('myinfo')
    .setDescription('Shows your current XP and perks.'),

  new SlashCommandBuilder()
    .setName('givexp')
    .setDescription('Gives XP to a user (Admin only).')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The user to give XP to.')
        .setRequired(true))
    .addIntegerOption(option =>
      option
        .setName('amount')
        .setDescription('The amount of XP to give.')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Shows the current XP leaderboard.'),
];

module.exports = { commands };
