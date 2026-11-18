-- Add docker-cloud to the active sandbox_provider enum.
--
-- ADD VALUE only: this migration never writes the new enum value in the same
-- transaction (PostgreSQL forbids that). Existing rows remain unchanged, and
-- Platinum remains the application default.
--
-- enum-value-checked: fresh schemas and every faked baseline currently expose
-- only daytona, platinum, and the retired-readable e2b value; docker-cloud is
-- absent until this forward migration runs.
ALTER TYPE "kortix"."sandbox_provider" ADD VALUE IF NOT EXISTS 'docker-cloud';
