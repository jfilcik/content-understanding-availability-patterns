[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroupName,
    [string]$SubscriptionId,
    [string]$ParameterFile = (Join-Path $PSScriptRoot "..\main.bicepparam"),
    [string]$AnalyzerDirectory = (Join-Path $PSScriptRoot "..\analyzers"),
    [ValidateRange(1, 3600)]
    [int]$OperationTimeoutSeconds = 300,
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$pythonCommand = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $pythonCommand) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
}
if (-not $pythonCommand) {
    throw "Python 3.10 or later is required."
}

$arguments = @(
    (Join-Path $PSScriptRoot "deploy.py"),
    "--resource-group", $ResourceGroupName,
    "--parameter-file", $ParameterFile,
    "--analyzers-dir", $AnalyzerDirectory,
    "--operation-timeout-seconds", "$OperationTimeoutSeconds"
)
if ($SubscriptionId) { $arguments += @("--subscription-id", $SubscriptionId) }
if ($ValidateOnly) { $arguments += "--validate-only" }
& $pythonCommand.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Deployment failed. See the diagnostic above."
}
