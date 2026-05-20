import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const pool = new Pool({
  host: requireEnv('DB_HOST'),
  port: parseInt(requireEnv('DB_PORT'), 10),
  user: requireEnv('DB_USER'),
  password: requireEnv('DB_PASSWORD'),
  database: requireEnv('DB_NAME'),
});

const DEMO_USERS = [
  { email: 'alice@example.com', password: 'password123' },
  { email: 'bob@example.com', password: 'password123' },
];

async function migrate() {
  const client = await pool.connect();
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'init.sql'), 'utf8');
    await client.query(sql);
    console.log('Schema applied.');

    for (const user of DEMO_USERS) {
      const hash = await bcrypt.hash(user.password, 10);
      await client.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [user.email, hash],
      );
      console.log(`User ${user.email} seeded.`);
    }

    console.log('Migration complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
