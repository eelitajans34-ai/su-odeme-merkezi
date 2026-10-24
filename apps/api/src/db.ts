import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

// bigint (int8) sütunlarını number olarak oku; tutarlar kuruş cinsindendir ve güvenli tamsayı aralığındadır.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('bigint değeri güvenli tamsayı aralığı dışında');
  return n;
});

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
