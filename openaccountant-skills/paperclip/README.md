# Open Accountant — Paperclip Company Template

An accounting department for your Paperclip company. Two specialized agents handle financial operations using the Open Accountant (Wilson) CLI.

## Org Chart

```
┌─────────────────────┐
│        CFO          │
│  Strategic finance   │
│  P&L, forecasts,    │
│  runway, taxes      │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│     Bookkeeper      │
│  Daily operations    │
│  Import, categorize, │
│  reconcile, reports  │
└─────────────────────┘
```

## Agents

### CFO
- **Role**: Strategic financial analysis and reporting
- **Heartbeat**: Weekly
- **Skills**: profit-loss, cash-flow-forecast, runway-calculator, quarterly-taxes, contractor-tracking, revenue-concentration

### Bookkeeper
- **Role**: Day-to-day transaction management
- **Heartbeat**: Daily
- **Skills**: import-transactions, smart-categorize, month-end-close, expense-optimizer, monthly-digest

## Import

```bash
npx paperclipai company import --from ./open-accountant
```

## Requirements

- [Open Accountant CLI](https://github.com/openaccountant/cli)
- [Paperclip adapter](https://github.com/openaccountant/adapter-paperclip)
- Bun runtime

## License

MIT
