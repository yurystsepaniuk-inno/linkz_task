import { Pool, PoolClient } from 'pg';

/**
 * Anything that can run a parameterised query — either the connection pool
 * or a transaction client. Repositories accept this so the same method works
 * inside or outside a transaction; the *service* layer owns the transaction
 * boundary and chooses which to pass.
 */
export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
