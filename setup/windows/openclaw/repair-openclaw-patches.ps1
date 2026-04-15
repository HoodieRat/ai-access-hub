param(
  [string]$OpenClawDistRoot = "$env:APPDATA\npm\node_modules\openclaw\dist"
)

$ErrorActionPreference = 'Stop'

function Update-FileText {
  param(
    [string]$Path,
    [string]$OldSnippet,
    [string]$NewSnippet,
    [string]$AlreadyPatchedMarker,
    [string]$OldPattern
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Required file not found: $Path"
  }

  $text = Get-Content -LiteralPath $Path -Raw
  if ($AlreadyPatchedMarker -and $text.Contains($AlreadyPatchedMarker)) {
    return $false
  }

  if ($OldSnippet -and $text.Contains($OldSnippet)) {
    $updated = $text.Replace($OldSnippet, $NewSnippet)
  } elseif ($OldPattern) {
    $updated = [regex]::Replace($text, $OldPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $NewSnippet }, 1)
    if ($updated -eq $text) {
      throw "Expected snippet was not found in $Path"
    }
  } else {
    throw "Expected snippet was not found in $Path"
  }

  $backupPath = "$Path.bak-codex"
  Copy-Item -LiteralPath $Path -Destination $backupPath -Force
  Set-Content -LiteralPath $Path -Value $updated -Encoding UTF8
  return $true
}

$helperPath = Join-Path $OpenClawDistRoot 'pi-embedded-helpers-CGU2Pfj9.js'
$runtimePath = Join-Path $OpenClawDistRoot 'agent-runner.runtime-DEDCwJ0o.js'

$helperOld = @'
if (status === 503) {
		if (messageReason === "overloaded") return messageClassification;
		return toReasonClassification("timeout");
	}
'@

$helperNew = @'
if (status === 503) {
		const normalizedMessage = message?.toLowerCase() ?? "";
		if (messageReason === "overloaded" || normalizedMessage.includes("no available providers") || normalizedMessage.includes("no viable providers") || normalizedMessage.includes("lane exhausted") || normalizedMessage.includes("temporarily unavailable")) return toReasonClassification("overloaded");
		return toReasonClassification("timeout");
	}
'@

$runtimeOld = @'
			if (errorCandidate && (isRateLimitErrorMessage(errorCandidate) || isOverloadedErrorMessage(errorCandidate))) {
				const isOverloaded = isOverloadedErrorMessage(errorCandidate);
				runResult.payloads = [{
					text: isOverloaded ? "âš ï¸ The AI service is temporarily overloaded. Please try again in a moment." : "âš ï¸ API rate limit reached â€” the model couldn't generate a response. Please try again in a moment.",
					isError: true
				}];
			}
'@

$runtimeNew = @'
			if (errorCandidate && (isRateLimitErrorMessage(errorCandidate) || isOverloadedErrorMessage(errorCandidate))) {
				const normalizedErrorCandidate = errorCandidate.toLowerCase();
				const isOverloaded = isOverloadedErrorMessage(errorCandidate) || normalizedErrorCandidate.includes("no available providers") || normalizedErrorCandidate.includes("no viable providers");
				const isLaneExhausted = normalizedErrorCandidate.includes("token headroom") || normalizedErrorCandidate.includes("quota is exhausted") || normalizedErrorCandidate.includes("no remaining");
				runResult.payloads = [{
					text: isOverloaded ? "âš ï¸ No AI providers are currently available for this lane. Please try again shortly or switch model lanes." : isLaneExhausted ? "âš ï¸ This AI lane is temporarily out of request or token headroom. Please try again shortly or switch model lanes." : "âš ï¸ API rate limit reached â€” the model couldn't generate a response. Please try again in a moment.",
					isError: true
				}];
			}
'@

$helperChanged = Update-FileText `
  -Path $helperPath `
  -OldSnippet $helperOld `
  -NewSnippet $helperNew `
  -AlreadyPatchedMarker 'normalizedMessage.includes("no available providers")' `
  -OldPattern 'if \(status === 503\) \{\s*if \(messageReason === "overloaded"\) return messageClassification;\s*return toReasonClassification\("timeout"\);\s*\}'

$runtimeChanged = Update-FileText `
  -Path $runtimePath `
  -OldSnippet $runtimeOld `
  -NewSnippet $runtimeNew `
  -AlreadyPatchedMarker 'No AI providers are currently available for this lane.' `
  -OldPattern 'if \(errorCandidate && \(isRateLimitErrorMessage\(errorCandidate\) \|\| isOverloadedErrorMessage\(errorCandidate\)\)\) \{\s*const isOverloaded = isOverloadedErrorMessage\(errorCandidate\);\s*runResult\.payloads = \[\{\s*text: isOverloaded \? ".*?The AI service is temporarily overloaded.*?" : ".*?API rate limit reached .*?model couldn''t generate a response.*?",\s*isError: true\s*\}\];\s*\}'

[pscustomobject]@{
  openclaw_dist = $OpenClawDistRoot
  helper_path = $helperPath
  runtime_path = $runtimePath
  helper_changed = $helperChanged
  runtime_changed = $runtimeChanged
} | ConvertTo-Json -Depth 3
