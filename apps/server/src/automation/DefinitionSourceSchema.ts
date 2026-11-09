import * as Effect from "effect/Effect";
import * as Database from "./AutomationDatabase.ts";

export const migrateDefinitionSources = Effect.gen(function* () {
  const sql = yield* Database.AutomationDatabase;
  yield* sql`ALTER TABLE foundry_automation.definition_git_revisions ADD COLUMN location jsonb`;
  yield* sql`CREATE UNIQUE INDEX definition_git_revision_location_commit ON foundry_automation.definition_git_revisions(factory_id,location,commit_sha) WHERE location IS NOT NULL`;
  yield* sql`ALTER TABLE foundry_automation.definition_git_revisions DROP CONSTRAINT definition_git_revisions_factory_id_commit_sha_key`;
});
