'use strict';
// Account management for the hosted edition (admin-provisioned accounts).
//   node admin-cli.js add <username> [password] [--admin]   create an account
//   node admin-cli.js passwd <username> [password]          reset a password
//   node admin-cli.js rm <username>                         delete an account + its data
//   node admin-cli.js list                                  list accounts
// If password is omitted, a strong random one is generated and printed once.
const crypto = require('crypto');
const auth = require('./auth.js');

const [, , cmd, arg1, arg2] = process.argv;
const isAdmin = process.argv.includes('--admin');
// Always includes a letter and a digit so it satisfies the password policy.
const genPw = () => {
  for (;;) {
    const p = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
    if (p.length >= 12 && /[a-zA-Z]/.test(p) && /[0-9]/.test(p)) return p;
  }
};

try {
  if (cmd === 'add') {
    if (!arg1) throw new Error('usage: add <username> [password] [--admin]');
    const pw = (arg2 && arg2 !== '--admin') ? arg2 : genPw();
    auth.createUser(arg1, pw, isAdmin);
    console.log(`Created ${isAdmin ? 'admin ' : ''}account "${arg1.toLowerCase()}"`);
    console.log(`  password: ${pw}`);
    console.log('  (share this securely; it is not stored in plain text)');
  } else if (cmd === 'passwd') {
    if (!arg1) throw new Error('usage: passwd <username> [password]');
    const pw = arg2 || genPw();
    auth.setPassword(arg1, pw);
    console.log(`Password reset for "${arg1.toLowerCase()}"`);
    console.log(`  password: ${pw}`);
  } else if (cmd === 'rm') {
    if (!arg1) throw new Error('usage: rm <username>');
    auth.deleteUser(arg1);
    console.log(`Deleted "${arg1.toLowerCase()}" and all their data`);
  } else if (cmd === 'list') {
    const rows = auth.listUsers();
    if (!rows.length) console.log('No accounts yet. Create one: node admin-cli.js add <username>');
    else rows.forEach(u => console.log(`  ${u.username}${u.is_admin ? '  [admin]' : ''}  (since ${String(u.created).slice(0, 10)})`));
  } else {
    console.log('Roost account admin\n  add <username> [password] [--admin]\n  passwd <username> [password]\n  rm <username>\n  list');
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
