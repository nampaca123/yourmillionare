# Contributing to Open Accountant Skills

Thanks for helping make financial AI accessible to everyone.

## Skill Format

Each skill is a directory containing a single `SKILL.md` file:

```
category/skill-name/SKILL.md
```

### SKILL.md Structure

```markdown
---
name: skill-name
description: >
  50-100 character trigger-focused description. Explain WHEN to use this skill,
  not just what it does. Start with a verb.
---

# Skill Title

## Overview

Brief explanation of what this skill does and who it's for.

## Wilson Tools Used

List of Open Accountant (Wilson) tools this skill leverages:
- `tool_name` — what it does

## Workflow

Numbered steps the agent follows.

## Without Wilson

How to accomplish this workflow without Open Accountant installed.
This section is required — it makes the skill useful in any AI agent.

## Important Notes

Caveats, disclaimers, or tips.
```

### Required Fields

- **name**: Kebab-case, globally unique (e.g., `subscription-audit`)
- **description**: Trigger-focused. Tells the agent WHEN to activate this skill.

### Required Sections

- **Workflow**: Step-by-step instructions the agent follows
- **Without Wilson**: Fallback instructions for agents that don't have Wilson tools. Be specific — name actual export paths, file formats, and manual steps.

## Categories

| Directory | For | Examples |
|-----------|-----|---------|
| `personal/` | Individual/household finance | Debt payoff, net worth, subscription audit |
| `business/` | Freelancer/small business | P&L, invoicing, contractor tracking |
| `shared/` | Both personal and business | Import transactions, categorize, tax prep |

If unsure, use `shared/`.

## Quality Expectations

- **Be specific, not generic.** "Export your Chase CSV from chase.com > Accounts > Download" beats "export your data."
- **Reference real tools.** Name Wilson tools by their actual function names.
- **Include fallbacks.** Every skill must work without Wilson — the "Without Wilson" section is not optional.
- **Add disclaimers where needed.** Tax skills must include "This is not tax advice" disclaimers.
- **Keep workflows actionable.** Each step should be something the agent can actually do, not vague advice.

## Submitting a Skill

1. Fork this repo
2. Create your skill directory: `category/your-skill-name/SKILL.md`
3. Follow the format above
4. Test: install your skill in Claude Code or Wilson and verify it works
5. Submit a PR with a clear description of what the skill does and who it helps

## What Not to Submit

- Skills that duplicate paid Open Accountant features (check openaccountant.ai/pricing)
- Skills that require API keys or external paid services to function
- Skills with hardcoded personal data or credentials
- Generic financial advice without actionable workflow steps
