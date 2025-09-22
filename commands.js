module.exports = {
  commands: [
    {
      name: "buycrate",
      description: "Buy a perk crate for 10,000 XP.",
    },
    {
      name: "leaderboardxp",
      description: "Shows the XP leaderboard.",
    },
    {
      name: "leaderboardperks",
      description: "Shows the perk leaderboard.",
    },
    {
      name: "myinfo",
      description: "Shows your current XP and perks.",
    },
    {
      name: "givexp",
      description: "Give a specific amount of XP to a user.",
      options: [
        {
          name: "user",
          type: 6, // USER type
          description: "The user to give XP to.",
          required: true,
        },
        {
          name: "amount",
          type: 4, // INTEGER type
          description: "The amount of XP to give.",
          required: true,
        },
      ],
      default_member_permissions: 8, // Administrator permission
    },
  ],
};
