# Rotating RELAY_DATA_KEY

`RELAY_DATA_KEY` seals queued message bodies (which hold reset and invitation links) and second-factor secrets. Rotate it on suspicion of exposure and at least yearly.

1. Generate a new key: `openssl rand -base64 32`.
2. Set `RELAY_DATA_KEY_PREVIOUS` to the **old** value and `RELAY_DATA_KEY` to the **new** one, then redeploy. New data is sealed with the new key; old data still opens with the previous one, so nothing breaks while rows are migrated.
3. Preview, then re-seal: `npm run secrets:rotate -- --dry-run`, then `npm run secrets:rotate`. It is idempotent and skips rows already under the current key.
4. Run it again with `--dry-run` and confirm `0 would be re-sealed` for every column.
5. Remove `RELAY_DATA_KEY_PREVIOUS` and redeploy.

**Rollback before step 5:** swap the two values back; every row is still readable by one of them. **After step 5** the old key is gone by design; keep it in your secrets manager for the retention period if you may need to restore an older database backup.
