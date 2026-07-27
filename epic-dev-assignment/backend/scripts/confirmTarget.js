import readline from 'node:readline/promises';
import { describeDatabase, databaseLabel } from '../db.js';

// Guard for scripts that WRITE to the database.
//
// Once local development points at the same Postgres as the deployed app — which
// removes the "which database am I looking at?" ambiguity — an absent-minded
// `npm run migrate` in a terminal that happens to be pointed at production is no
// longer harmless. So: always print the target, and for a REMOTE database make
// the operator confirm it out loud.
//
// Bypass for CI and for Railway's own shell, where there is no TTY to answer:
//   CONFIRM_REMOTE_DB=1   or   --yes
export async function confirmTarget(action) {
  const db = describeDatabase();
  console.log(`\n  ${action}`);
  console.log(`  target: ${databaseLabel()}\n`);

  if (db.isLocal) return true;

  if (process.env.CONFIRM_REMOTE_DB === '1' || process.argv.includes('--yes')) {
    console.log('  (remote target confirmed by CONFIRM_REMOTE_DB / --yes)\n');
    return true;
  }

  if (!process.stdin.isTTY) {
    console.error(
      '  REFUSING: this is a REMOTE database and there is no terminal to confirm on.\n' +
      '  Re-run with --yes (or CONFIRM_REMOTE_DB=1) if that is genuinely what you want.\n'
    );
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Typing the database name, rather than "y", is deliberate: it cannot be
    // answered by reflex, and it fails if you thought you were somewhere else.
    const answer = await rl.question(`  This is a REMOTE database. Type "${db.database}" to continue: `);
    if (answer.trim() !== db.database) {
      console.error('\n  Aborted — nothing was changed.\n');
      return false;
    }
    console.log('');
    return true;
  } finally {
    rl.close();
  }
}
