# Fix password input in configure2SVPolicy.cjs
$file = "configure2SVPolicy.cjs"
$lines = Get-Content $file

for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "await page\.click\('input\[type=") {
        # Replace click with focus
        $lines[$i] = "                // Focus and type password"
        $lines[$i+1] = "                await page.focus('input[type=""password""]');"
        $lines[$i+2] = "                await page.keyboard.down('Control');"
        $lines[$i+3] = "                await page.keyboard.press('A');"
        $lines[$i+4] = "                await page.keyboard.up('Control');"
        $lines[$i+5] = "                await page.keyboard.press('Backspace');"
        $i += 4  # Skip next 4 lines
    }
}

$lines | Set-Content $file
Write-Host "Fixed password input in configure2SVPolicy.cjs"
