const { Client } = require("pg");

const client = new Client({
  connectionString: "postgresql://postgres.jiekqrbzdjsskevhrbts:JZRBnY_%2A%2BDw6zH%2F@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?schema=pingpong",
});

async function run() {
  try {
    await client.connect();

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'pingpong' AND table_name = 'SiteSettings' AND column_name = 'pollIntervalMs'
        ) THEN
          ALTER TABLE pingpong."SiteSettings" ADD COLUMN "pollIntervalMs" INTEGER NOT DEFAULT 1000;
        END IF;
      END $$;
    `);
    console.log("pollIntervalMs column added to SiteSettings");

    // Verify
    const result = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'pingpong' AND table_name = 'SiteSettings' ORDER BY ordinal_position`
    );
    console.log("SiteSettings columns:", result.rows.map(r => r.column_name).join(", "));
  } catch (e) {
    console.error("FAILED:", e.message);
  } finally {
    await client.end();
  }
}

run();
