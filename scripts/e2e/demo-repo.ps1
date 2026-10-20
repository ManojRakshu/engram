# A small Python repo with history: invoice.py and discount.py usually change together.
param([string]$Dir)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force "$Dir\billing", "$Dir\tests" | Out-Null
git -C $Dir init -q
git -C $Dir config user.email "dev@example.com"; git -C $Dir config user.name "Dev"
function Commit($msg) { git -C $Dir add -A; git -C $Dir commit -qm $msg }
Set-Content "$Dir\billing\__init__.py" ""
Set-Content "$Dir\billing\discount.py" "def apply_discount(base, pct):`n    return base * (1 - pct)`n"
Set-Content "$Dir\billing\invoice.py" "from billing.discount import apply_discount`n`n`ndef price(item):`n    return apply_discount(item['base'], item['discount'])`n`n`ndef total(items):`n    return sum(price(i) for i in items)`n"
Commit "billing: invoice totals with discounts"
Add-Content "$Dir\billing\discount.py" "`n`ndef clamp(pct):`n    return max(0.0, min(pct, 1.0))`n"
Add-Content "$Dir\billing\invoice.py" "`n`ndef subtotal(items):`n    return sum(i['base'] for i in items)`n"
Commit "discount: clamp percentages"
Set-Content "$Dir\tests\test_invoice.py" "from billing.invoice import total`n`n`ndef test_total():`n    assert total([{'base': 100, 'discount': 0.1}]) == 90`n"
Add-Content "$Dir\billing\invoice.py" "`n# totals are rounded by the caller`n"
Add-Content "$Dir\billing\discount.py" "`n# pct is a fraction, not a percent`n"
Commit "tests for invoice totals"
