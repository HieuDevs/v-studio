; Inno Setup script for V Studio (Windows installer).
;   iscc /DAppVersion=1.0.0 packaging\windows\installer.iss
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{D379B268-F536-4D2D-8E28-1CE5EF6214DA}
AppName=V Studio
AppVersion={#AppVersion}
AppPublisher=HieuDevs
AppPublisherURL=https://github.com/HieuDevs/v-studio
DefaultDirName={autopf}\V Studio
DefaultGroupName=V Studio
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\build\installers
OutputBaseFilename=V-Studio-{#AppVersion}-Windows-x64-Setup
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\VStudio.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\..\build\dist\VStudio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\V Studio"; Filename: "{app}\VStudio.exe"
Name: "{autodesktop}\V Studio"; Filename: "{app}\VStudio.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\VStudio.exe"; Description: "{cm:LaunchProgram,V Studio}"; Flags: nowait postinstall skipifsilent

