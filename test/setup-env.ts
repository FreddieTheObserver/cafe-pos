/**
 * Integration specs talk to the real Postgres from docker-compose. Locally that
 * means reading .env (host port 5433); CI sets DATABASE_URL in the job env, and
 * dotenv never overwrites an existing variable, so both work unchanged.
 */
import 'dotenv/config';
