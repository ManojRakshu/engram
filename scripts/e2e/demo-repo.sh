#!/bin/sh
# A small Python repo with history: invoice.py and discount.py usually change together (same as demo-repo.ps1).
set -e
D="$1"
mkdir -p "$D/billing" "$D/tests"
cd "$D"
git init -q
git config user.email "dev@example.com"
git config user.name "Dev"
: > billing/__init__.py
printf 'def apply_discount(base, pct):\n    return base * (1 - pct)\n' > billing/discount.py
printf "from billing.discount import apply_discount\n\n\ndef price(item):\n    return apply_discount(item['base'], item['discount'])\n\n\ndef total(items):\n    return sum(price(i) for i in items)\n" > billing/invoice.py
git add -A && git commit -qm "billing: invoice totals with discounts"
printf '\n\ndef clamp(pct):\n    return max(0.0, min(pct, 1.0))\n' >> billing/discount.py
printf "\n\ndef subtotal(items):\n    return sum(i['base'] for i in items)\n" >> billing/invoice.py
git add -A && git commit -qm "discount: clamp percentages"
printf "from billing.invoice import total\n\n\ndef test_total():\n    assert total([{'base': 100, 'discount': 0.1}]) == 90\n" > tests/test_invoice.py
printf '\n# totals are rounded by the caller\n' >> billing/invoice.py
printf '\n# pct is a fraction, not a percent\n' >> billing/discount.py
git add -A && git commit -qm "tests for invoice totals"
