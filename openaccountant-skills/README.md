# Open Accountant Skills

Free, open-source financial skills for AI agents. Works with [Wilson CLI](https://github.com/openaccountant/cli), Claude Code, Cursor, OpenAI Codex, Gemini CLI, GitHub Copilot, [Pi](https://github.com/badlogic/pi-mono), [OpenCode](https://opencode.ai), Kiro, Trae, Rovo Dev, Paperclip, and any agent that supports SKILL.md files.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

## Install

**Any agent** (Claude Code, Cursor, Codex, Gemini CLI, Copilot, Pi, OpenCode, Kiro, Trae, Rovo Dev)
```bash
npx skills add openaccountant/skills
```

Install a single skill:
```bash
npx skills add openaccountant/skills --skill tax-prep
```

**Pi**
```bash
pi install git:github.com/openaccountant/skills
```

**Wilson CLI** (auto-discovered)
```bash
git clone https://github.com/openaccountant/skills.git ~/.openaccountant/skills
```

**Browse available skills**
```bash
npx skills add openaccountant/skills --list
```

See all 44 skills on [skills.sh](https://skills.sh/openaccountant/skills) or [openaccountant.ai/skills](https://openaccountant.ai/skills).

### Platform compatibility

| Platform | Config dir | Discovery path | Fallback |
|----------|-----------|----------------|----------|
| Claude Code | `.claude/` | `.claude/skills/`, `~/.claude/skills/` | — |
| Cursor | `.cursor/` | `.cursor/skills/` | `.agents/`, `.claude/`, `.codex/` |
| OpenAI Codex | `.agents/` | `.agents/skills/`, `~/.codex/skills/` | — |
| Gemini CLI | `.gemini/` | `.gemini/skills/` | `.agents/` |
| GitHub Copilot | `.agents/` | `.github/skills/`, `.agents/skills/` | `.claude/` |
| Pi | `.pi/` | `~/.pi/agent/skills/` | `.agents/` |
| OpenCode | `.opencode/` | `.opencode/skills/` | `.agents/`, `.claude/` |
| Kiro | `.kiro/` | `.kiro/skills/` | — |
| Trae | `.trae/` | `.trae/skills/` | — |
| Trae (China) | `.trae-cn/` | `.trae-cn/skills/` | — |
| Rovo Dev | `.rovodev/` | `.rovodev/skills/`, `~/.rovodev/skills/` | — |
| Paperclip | Via adapter | `~/.openaccountant/skills/` | — |
| Wilson CLI | — | `~/.openaccountant/skills/` | — |

## Skills

### Personal Finance

| Skill | Description |
|-------|-------------|
| [subscription-audit](personal/subscription-audit/) | Find and cancel unused subscriptions |
| [debt-payoff](personal/debt-payoff/) | Avalanche vs snowball debt payoff plans |
| [net-worth](personal/net-worth/) | Track assets, liabilities, and net worth over time |
| [emergency-fund](personal/emergency-fund/) | Build and monitor your emergency fund |
| [financial-goals](personal/financial-goals/) | Set and track savings goals with timelines |
| [lifestyle-creep](personal/lifestyle-creep/) | Detect spending increases as income grows |
| [zero-based-budget](personal/zero-based-budget/) | Allocate every dollar of income to a purpose |
| [insurance-audit](personal/insurance-audit/) | Review insurance coverage and find savings |
| [charitable-giving](personal/charitable-giving/) | Track donations and estimate tax benefits |
| [spending-review](personal/spending-review/) | Categorized spending breakdown with trends |

### Business & Freelancer

| Skill | Description |
|-------|-------------|
| [profit-loss](business/profit-loss/) | Generate P&L / income statements |
| [invoice-aging](business/invoice-aging/) | Track unpaid invoices and collection timelines |
| [contractor-tracking](business/contractor-tracking/) | Monitor 1099 contractor payments |
| [cash-flow-forecast](business/cash-flow-forecast/) | Project future cash flow from trends |
| [break-even-calc](business/break-even-calc/) | Calculate break-even revenue targets |
| [client-profitability](business/client-profitability/) | Revenue and costs per client |
| [pricing-optimizer](business/pricing-optimizer/) | Analyze pricing against costs and margins |
| [runway-calculator](business/runway-calculator/) | Months of runway at current burn rate |
| [revenue-concentration](business/revenue-concentration/) | Client concentration risk analysis |
| [seasonal-patterns](business/seasonal-patterns/) | Detect revenue and expense seasonality |
| [month-end-close](business/month-end-close/) | Monthly bookkeeping close checklist |
| [multi-entity](business/multi-entity/) | Manage finances across multiple businesses |
| [rental-property](business/rental-property/) | Track rental income, expenses, and ROI |
| [stripe-import](business/stripe-import/) | Import Stripe payment data |
| [paypal-import](business/paypal-import/) | Import PayPal transaction history |
| [square-import](business/square-import/) | Import Square sales data |
| [wise-import](business/wise-import/) | Import Wise (TransferWise) transactions |
| [venmo-reconciler](business/venmo-reconciler/) | Reconcile Venmo business transactions |

### Shared (Personal & Business)

| Skill | Description |
|-------|-------------|
| [import-transactions](shared/import-transactions/) | Import from CSV, OFX, or QIF files |
| [smart-categorize](shared/smart-categorize/) | Auto-categorize transactions by pattern |
| [smart-split](shared/smart-split/) | Split transactions across categories |
| [bank-sync](shared/bank-sync/) | Connect bank accounts for automatic import |
| [custom-report](shared/custom-report/) | Build custom financial reports |
| [monthly-digest](shared/monthly-digest/) | Monthly financial summary with highlights |
| [year-end-summary](shared/year-end-summary/) | Annual financial review and insights |
| [expense-optimizer](shared/expense-optimizer/) | Find recurring expenses to cut or reduce |
| [tax-prep](shared/tax-prep/) | Organize expenses by IRS Schedule C categories |
| [quarterly-taxes](shared/quarterly-taxes/) | Estimate and track quarterly tax payments |
| [mileage-tracker](shared/mileage-tracker/) | Track business mileage for tax deductions |
| [home-office-deduction](shared/home-office-deduction/) | Calculate home office tax deduction |
| [sales-tax-nexus](shared/sales-tax-nexus/) | Determine sales tax obligations by state |
| [depreciation-schedule](shared/depreciation-schedule/) | Track asset depreciation for tax purposes |
| [tax-penalty-calc](shared/tax-penalty-calc/) | Estimate underpayment penalties |
| [state-tax-estimator](shared/state-tax-estimator/) | Estimate state income tax liability |

## With Wilson vs Without

Every skill works in two modes:

- **With Wilson**: Uses Open Accountant tools (`transaction_search`, `spending_summary`, `anomaly_detect`, etc.) for direct database queries and analysis.
- **Without Wilson**: Provides step-by-step instructions for working with exported CSV files, spreadsheets, or manual data entry. Works in any AI agent.

## Pro Skills

Want deeper analysis with chain orchestration, multi-step workflows, and premium tools? Check out [Open Accountant Pro](https://openaccountant.ai/pricing).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the skill format spec, quality expectations, and PR process.

## License

MIT
