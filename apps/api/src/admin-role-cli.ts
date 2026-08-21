import { Pool, type PoolClient } from 'pg';

type AdminRole = 'user' | 'admin';
type UserSelector = { email: string } | { username: string } | { id: string };

export interface RoleChangeResult {
  id: string;
  username: string;
  email: string;
  previousRole: AdminRole;
  role: AdminRole;
}

export async function setAdminRole(
  client: PoolClient,
  selector: UserSelector,
  role: AdminRole,
): Promise<RoleChangeResult> {
  const [column, rawValue] = 'email' in selector
    ? ['email_normalized', selector.email.toLowerCase()]
    : 'username' in selector
      ? ['username_normalized', selector.username.toLowerCase()]
      : ['id', selector.id];
  const found = await client.query<{
    id: string; username: string; email: string; role: AdminRole;
  }>(`SELECT id, username, email, role FROM users WHERE ${column} = $1 FOR UPDATE`, [rawValue]);
  const user = found.rows[0];
  if (!user) throw new Error('User was not found. No changes were made.');

  await client.query('UPDATE users SET role = $1, updated_at = now() WHERE id = $2', [role, user.id]);
  await client.query(`
    INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, metadata)
    VALUES (NULL, $1, 'user', $2, $3::jsonb)
  `, [
    role === 'admin' ? 'admin.role.grant' : 'admin.role.revoke',
    user.id,
    JSON.stringify({ source: 'admin_role_cli', username: user.username, previousRole: user.role, role }),
  ]);
  return { ...user, previousRole: user.role, role };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'grant' && command !== 'revoke') throw usage();
  const selector = parseSelector(process.argv.slice(3));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: 'clirace-admin-role-cli' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await setAdminRole(client, selector, command === 'grant' ? 'admin' : 'user');
    await client.query('COMMIT');
    console.log(`${command === 'grant' ? 'Granted admin role' : 'Revoked admin role'}:`);
    console.log(`  id: ${result.id}`);
    console.log(`  username: ${result.username}`);
    console.log(`  email: ${result.email}`);
    console.log(`  role: ${result.previousRole} -> ${result.role}`);
    console.log('Audit event recorded. Password and sessions were not changed.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function parseSelector(args: string[]): UserSelector {
  const accepted = ['email', 'username', 'id'] as const;
  const matches: Array<{ key: typeof accepted[number]; value: string }> = [];
  for (const key of accepted) {
    const equals = args.find((arg) => arg.startsWith(`--${key}=`));
    const index = args.indexOf(`--${key}`);
    const value = equals?.slice(key.length + 3) ?? (index >= 0 ? args[index + 1] : undefined);
    if (value?.trim()) matches.push({ key, value: value.trim() });
  }
  if (matches.length !== 1) throw usage();
  const match = matches[0]!;
  if (match.key === 'email') return { email: match.value };
  if (match.key === 'username') return { username: match.value };
  if (!/^\d+$/.test(match.value)) throw usage();
  return { id: match.value };
}

function usage(): Error {
  return new Error('Usage: admin-role-cli.js <grant|revoke> (--email value | --username value | --id value)');
}

if (process.argv[1]?.endsWith('admin-role-cli.js')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
