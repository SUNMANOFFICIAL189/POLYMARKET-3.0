---
name: Assessment Cycle Protocol
description: The mandatory question pattern and decision cycle to follow for every bot assessment, change, and monitoring session
type: feedback
---

## PATS-Copy Assessment Cycle

Every assessment, change, or optimisation must follow this cycle. No stage can be skipped. Each requires explicit user sign-off before proceeding.

### The Cycle

```
ASSESS → DIAGNOSE → FORECAST → DISCUSS → PLAN → EXECUTE → MONITOR → REPEAT
```

Optional insert between DIAGNOSE and FORECAST:
- **RESEARCH** — only when the user has found an external tool/model/repo to evaluate

### Stage Details

**1. ASSESS — "What's happening right now?"**
- Pull live data: PM2 status, logs, Supabase trades
- Current balance, WR, open positions, active errors
- Filter activity counts (what's blocking, what's passing)
- Daily PnL breakdown with cumulative balance

**2. DIAGNOSE — "WHY is this happening?"**
- Root cause analysis, not just symptoms
- Explain in simple terms — user prefers plain language over jargon
- Identify which specific filters/wallets/market types are driving results
- Compare against historical performance (what changed?)

**3. RESEARCH — "What's out there that could help?" (ONLY when user provides something to evaluate)**
- Only triggered when user shares a specific tool/repo/model to assess
- Evaluate viability, enhancement potential, cost, integration effort
- Always compare against current setup — is it actually better?
- Do NOT proactively suggest external tools

**4. FORECAST — "What will this change actually do?"**
- Backtest proposed changes against ALL historical trade data
- Show PnL impact of each change independently AND combined
- Run optimal config search across parameter combinations
- Volume projections at different trade rates
- Show what would have been skipped and whether those were winners or losers
- User quote: "We're making a lot of changes without realising the true outcome"

**5. DISCUSS — "Let me proof it first"**
- Present the report and recommendations
- Make NO code changes until user approves
- User reviews findings, asks clarifying questions
- Iterate on the plan if needed

**6. PLAN — "How will we execute?"**
- Break changes into discrete steps
- Identify files to modify
- Specify exact values/logic changes
- User approves the plan before execution begins

**7. EXECUTE — "Do it"**
- Implement approved changes only
- Deploy to server, rebuild, restart
- Sync local + GitHub
- Confirm startup is clean

**8. MONITOR — "Did it work?"**
- Run assessment after changes have had time to take effect (typically 12-24h minimum)
- Compare before/after metrics
- If results aren't as forecast, loop back to ASSESS

### Key Principles

- **Data over intuition** — every decision backed by historical trade data
- **No restrictions without evidence** — filters must prove they save money via backtest before deploying
- **Volume matters** — the strategy profits from longshot hits, which require trade volume
- **Simple explanations** — user prefers plain language, analogies, "explain like I'm 5" when needed
- **No proactive changes** — never modify code without explicit user approval

**Why:** User identified that changes were being made without understanding their true impact. This cycle ensures every change is evidence-based and user-approved.

**How to apply:** At the start of any assessment or optimisation conversation, follow this cycle sequentially. When the user says "run an assessment report", begin at Stage 1.
