-- The application role must not be a superuser: row-level security would be bypassed.
CREATE ROLE dentosim LOGIN PASSWORD 'dentosim' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE dentosim OWNER dentosim;
\connect dentosim
ALTER SCHEMA public OWNER TO dentosim;
