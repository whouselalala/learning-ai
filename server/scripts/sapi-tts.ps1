param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Voice = 'Microsoft Huihui Desktop',
  [int]$Rate = 0,
  [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if (-not $text -or $text.Trim().Length -eq 0) {
  Write-Error 'empty text'
  exit 2
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
  if ($voices -contains $Voice) {
    $synth.SelectVoice($Voice)
  } elseif ($voices.Count -gt 0) {
    $synth.SelectVoice($voices[0])
  }
  $synth.Rate = $Rate
  $synth.Volume = $Volume
  $dir = Split-Path -Parent $OutFile
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $synth.SetOutputToWaveFile($OutFile)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
exit 0
