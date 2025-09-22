const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const fs = require('fs');

async function generateLeaderboardImage(title, users, metricName) {
    const width = 800;
    const height = 100 + users.length * 70;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');

    // Background
    context.fillStyle = '#36393F';
    context.fillRect(0, 0, width, height);

    // Title
    context.fillStyle = '#FFFFFF';
    context.font = 'bold 40px sans-serif';
    context.textAlign = 'center';
    context.fillText(title, width / 2, 50);

    // Leaderboard entries
    context.font = '24px sans-serif';
    context.textAlign = 'left';
    let y = 120;

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const rank = i + 1;
        const rankColor = rank === 1 ? '#FFD700' : rank === 2 ? '#C0C0C0' : rank === 3 ? '#CD7F32' : '#FFFFFF';

        // Rank
        context.fillStyle = rankColor;
        context.fillText(`${rank}.`, 50, y);

        // Avatar
        if (user.avatarUrl) {
            try {
                const avatar = await loadImage(user.avatarUrl);
                context.save();
                context.beginPath();
                context.arc(100, y - 10, 30, 0, Math.PI * 2, true);
                context.closePath();
                context.clip();
                context.drawImage(avatar, 70, y - 40, 60, 60);
                context.restore();
            } catch (err) {
                console.error(`Failed to load avatar for ${user.name}:`, err);
            }
        }

        // Username
        context.fillStyle = '#FFFFFF';
        context.fillText(user.name, 150, y);

        // Metric
        context.fillStyle = '#00FF00';
        context.textAlign = 'right';
        context.fillText(`${user.value} ${metricName}`, width - 50, y);

        y += 70;
    }

    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(path.join(__dirname, 'leaderboard.png'), buffer);
}

module.exports = { generateLeaderboardImage };
