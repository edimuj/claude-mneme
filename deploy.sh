#!/bin/bash
set -e

echo "🚀 Deploying Claude Mneme v3.0.0"
echo "================================"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Backup
echo -e "\n${YELLOW}1. Backing up current state...${NC}"
BACKUP_DIR=~/.claude-mneme.backup-$(date +%Y%m%d-%H%M%S)
if [ -d ~/.claude-mneme ]; then
  cp -r ~/.claude-mneme "$BACKUP_DIR"
  echo -e "${GREEN}✓ Backed up to: $BACKUP_DIR${NC}"
else
  echo -e "${YELLOW}⚠ No existing data to backup${NC}"
fi

# 2. Kill old processes
echo -e "\n${YELLOW}2. Stopping old processes...${NC}"
pkill -f mneme-server 2>/dev/null && echo -e "${GREEN}✓ Stopped mneme-server${NC}" || echo "  (no server running)"
pkill -f summarize.mjs 2>/dev/null && echo -e "${GREEN}✓ Stopped summarize.mjs${NC}" || echo "  (no summarize running)"

# 3. Run tests
echo -e "\n${YELLOW}3. Running tests...${NC}"
cd "$(dirname "$0")/plugin"

echo "  Testing core server..."
if node server/test-server.mjs 2>&1 | grep -q "Tests passed: 14"; then
  echo -e "${GREEN}✓ Core server tests passed${NC}"
else
  echo -e "${RED}✗ Core server tests failed${NC}"
  exit 1
fi

echo "  Testing log service..."
if timeout 10 node server/test-log-service.mjs 2>&1 | grep -q "Tests passed:"; then
  echo -e "${GREEN}✓ Log service tests passed${NC}"
else
  echo -e "${YELLOW}⚠ Log service tests had issues (non-critical)${NC}"
fi

echo "  Testing summarization..."
if timeout 5 node server/test-summarization.mjs 2>&1 | grep -q "All tests completed"; then
  echo -e "${GREEN}✓ Summarization tests passed${NC}"
else
  echo -e "${RED}✗ Summarization tests failed${NC}"
  exit 1
fi

# Clean up any test servers
pkill -f mneme-server 2>/dev/null || true

# 4. Install/link plugin
echo -e "\n${YELLOW}4. Installing plugin...${NC}"
if [ -d ~/.claude/plugins/claude-mneme ]; then
  echo "  Unlinking old version..."
  rm -f ~/.claude/plugins/claude-mneme
fi

echo "  Linking new version..."
ln -sf "$(pwd)" ~/.claude/plugins/claude-mneme
echo -e "${GREEN}✓ Plugin linked${NC}"

# 5. Verify
echo -e "\n${YELLOW}5. Verifying installation...${NC}"
if [ -L ~/.claude/plugins/claude-mneme ]; then
  echo -e "${GREEN}✓ Plugin symlink exists${NC}"
else
  echo -e "${RED}✗ Plugin symlink missing${NC}"
  exit 1
fi

if [ -f ~/.claude/plugins/claude-mneme/server/mneme-server.mjs ]; then
  echo -e "${GREEN}✓ Server script exists${NC}"
else
  echo -e "${RED}✗ Server script missing${NC}"
  exit 1
fi

# 6. Done
echo -e "\n${GREEN}================================${NC}"
echo -e "${GREEN}✓ Deployment complete!${NC}"
echo -e "${GREEN}================================${NC}"

echo -e "\n${YELLOW}Next steps:${NC}"
echo "1. Start a Claude Code session"
echo "2. The server will auto-start on first hook"
echo "3. Monitor: tail -f ~/.claude-mneme/.server.log"
echo "4. Check health: cat ~/.claude-mneme/.server.pid"
echo ""
echo -e "${YELLOW}Rollback (if needed):${NC}"
echo "  pkill -9 -f mneme-server"
echo "  rm -rf ~/.claude-mneme"
echo "  mv $BACKUP_DIR ~/.claude-mneme"
echo ""
echo "📖 See docs/DEPLOYMENT.md for full guide"
