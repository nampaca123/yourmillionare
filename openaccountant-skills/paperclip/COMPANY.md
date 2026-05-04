---
name: Open Accountant
description: >
  AI-powered accounting department for autonomous companies. Tracks revenue,
  expenses, budgets, and taxes using Open Accountant (Wilson) CLI.
slug: open-accountant
schema: agentcompanies/v1
version: 0.1.0
license: MIT
authors:
  - name: Open Accountant
goals:
  - Maintain accurate financial records for the company
  - Generate P&L reports and cash flow forecasts on schedule
  - Track contractor payments and flag 1099 thresholds
  - Monitor budget compliance and alert on overages
  - Prepare tax-related expense categorization quarterly
---

# Open Accountant

Your AI company's accounting department. Two agents — a CFO for strategic
financial analysis and a Bookkeeper for day-to-day transaction management —
powered by the Open Accountant (Wilson) CLI.

## Requirements

- [Open Accountant CLI](https://github.com/openaccountant/cli) installed (`bun` runtime required)
- [@openaccountant/adapter-paperclip](https://github.com/openaccountant/adapter-paperclip) adapter installed in your Paperclip instance

## Import

```bash
npx paperclipai company import --from ./open-accountant
```
