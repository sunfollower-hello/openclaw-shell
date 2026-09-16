#!/bin/bash
# SoulBox 服务器每日备份：管理台数据 + OpenClaw 全部（含通道凭证/会话）
# 保留最近 7 份，超出自动删。建议 cron：0 4 * * * /data/scripts/server-backup.sh
set -e
KEEP=7
STAMP=$(date +%Y%m%d)
OUT=/data/backups
mkdir -p "$OUT"
tar -czf "$OUT/soulbox-$STAMP.tar.gz" \
  --exclude='*.log' \
  -C /data openclaw-shell/data openclaw-shell/.env openclaw
# 只留最近 KEEP 份
ls -1t "$OUT"/soulbox-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "备份完成: $OUT/soulbox-$STAMP.tar.gz ($(du -h "$OUT/soulbox-$STAMP.tar.gz" | cut -f1))"
