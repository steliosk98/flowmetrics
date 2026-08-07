# Backup and restore

Run `scripts/backup.sh [output.dump]` from the repository directory. It streams a custom-format `pg_dump` from the PostgreSQL service without placing database credentials in the command line.

Restore replaces existing records. Stop external writers, verify the file and target instance, then run:

```bash
FLOWMETRICS_CONFIRM_RESTORE=YES_REPLACE_DATABASE scripts/restore.sh backup.dump
```

Test restores periodically. Keep the application data volume with its encryption key alongside database backups when connector configuration must remain decryptable.
