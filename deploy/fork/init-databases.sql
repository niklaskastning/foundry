CREATE ROLE foundry_automation_owner NOLOGIN;
CREATE ROLE foundry_connect_owner NOLOGIN;
CREATE DATABASE fork_automation OWNER foundry_automation_owner;
CREATE DATABASE fork_connect OWNER foundry_connect_owner;
REVOKE ALL ON DATABASE fork_automation FROM PUBLIC;
REVOKE ALL ON DATABASE fork_connect FROM PUBLIC;
\connect fork_automation
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect fork_connect
REVOKE ALL ON SCHEMA public FROM PUBLIC;
