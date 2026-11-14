import { config } from './config.mjs';
import { openDatabase, audit } from './db.mjs';
import argon2 from 'argon2';
import readline from 'node:readline';
// Initial account creation is local CLI only; never exposed as an HTTP setup endpoint.
const db = openDatabase(config.data);
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
    console.error('Administrator already exists. Bootstrap is permanently closed.');
    process.exit(1);
}
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
});
function ask(question, hidden = false) {
    return new Promise((resolve) => {
        process.stdout.write(question);
        if (hidden) {
            const original = rl._writeToOutput;
            rl._writeToOutput = () => {};
            rl.question('', (answer) => {
                rl._writeToOutput = original;
                process.stdout.write('\n');
                resolve(answer);
            });
        } else rl.question('', resolve);
    });
}
try {
    const username = await ask('Administrator username: ');
    const password = await ask('Password (at least 14 characters; hidden): ', true);
    const confirm = await ask('Repeat password (hidden): ', true);
    if (
        !/^[\p{L}\p{N}_.-]{3,64}$/u.test(username) ||
        password.length < 14 ||
        password.length > 256 ||
        password !== confirm
    )
        throw new Error('Invalid username, password length, or password mismatch');
    const hashed = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
    });
    db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(username, hashed);
    audit(db, username, 'bootstrap', 'local-cli');
    console.log('Administrator created.');
} catch (e) {
    console.error(e.message);
    process.exitCode = 1;
} finally {
    rl.close();
    db.close();
}
