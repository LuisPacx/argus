# Delete the argus backup database (approved 2026-11-22)

Status: needs-info

Luis approved deleting "the backup database" in the 2026-11-22 handoff; the file was not named. Candidates on disk:
- ~/.cache/argus-backups/argus-pre-reset-2026-11-12.db (likely the one)
- ~/.cache/claude-tmp/argus-tKEaE9/ and ~/.cache/claude-tmp/argus-4pEnn4/ (full argus.db + WAL; look like leaked temp dirs, see phase-1-build-path/19)

Question for Luis: which of these to delete.

## Comments
