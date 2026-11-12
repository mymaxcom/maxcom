; MAXCOM: Windows box setup as one .exe (Inno Setup 6).
; The exe is only a carrier: it unpacks the finished bundle folder to a fresh random folder under
; ProgramData (locked to SYSTEM and Administrators BEFORE any file is written; never the user-writable %TEMP%)
; and runs setup\setup.ps1 from there in a visible console window. All install logic stays in setup.ps1 (it owns the Add/Remove Programs entry).
; Built by scripts\setup\build-setup-exe.ps1, which passes:
;   /DMyVersion=<YYYY.MM.N>  /DBundleDir=<bundle folder>  /DOutDir=<output folder>  /DOutBase=<exe base name>
;   optional /DIconFile=<.ico>
; ASCII only on purpose.

#ifndef MyVersion
  #error MyVersion mesti diberi (/DMyVersion=2026.11.2)
#endif
#ifndef BundleDir
  #error BundleDir mesti diberi (/DBundleDir=...)
#endif
#ifndef OutDir
  #error OutDir mesti diberi (/DOutDir=...)
#endif
#ifndef OutBase
  #error OutBase mesti diberi (/DOutBase=...)
#endif

[Setup]
AppId={{6B1E2F0A-3C4D-4E5F-8A9B-0C1D2E3F4A5B}
AppName=MAX Kiosk Server
AppVersion={#MyVersion}
AppPublisher=MAXCOM
VersionInfoVersion={#MyVersion}.0
VersionInfoProductName=MAX Kiosk Server
VersionInfoDescription=Pemasang kotak MAX Kiosk Server
PrivilegesRequired=admin
Uninstallable=no
CreateUninstallRegKey=no
CreateAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
DisableWelcomePage=no
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
OutputDir={#OutDir}
OutputBaseFilename={#OutBase}
#ifdef IconFile
SetupIconFile={#IconFile}
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
SetupAppTitle=Pasang MAX Kiosk Server
SetupWindowTitle=Pasang MAX Kiosk Server %1
ExitSetupTitle=Keluar daripada pemasangan
ExitSetupMessage=Pemasangan belum selesai. Jika anda keluar sekarang, MAX Kiosk Server tidak akan dipasang.%n%nKeluar daripada pemasangan?
ButtonBack=< &Kembali
ButtonNext=&Seterusnya >
ButtonInstall=&Pasang
ButtonCancel=Batal
ButtonFinish=&Selesai
ButtonYes=&Ya
ButtonNo=&Tidak
ButtonOK=OK
WelcomeLabel1=Selamat datang ke pemasangan MAX Kiosk Server
WelcomeLabel2=Pemasang ini akan memasang MAX Kiosk Server versi {#MyVersion} pada komputer ini.%n%nSemua fail yang diperlukan sudah ada dalam fail ini. Tiada apa dimuat turun.%n%nTutup program lain sebelum menyambung.
WizardReady=Sedia untuk memasang
ReadyLabel1=Pemasang sudah bersedia untuk memasang MAX Kiosk Server pada komputer ini.
ReadyLabel2b=Tekan Pasang untuk bermula. Satu tetingkap konsol akan dibuka dan menunjukkan langkah pemasangan. Jangan tutup tetingkap itu sehingga selesai.
WizardInstalling=Memasang
InstallingLabel=Sila tunggu, MAX Kiosk Server sedang dipasang. Ikut langkah dalam tetingkap konsol yang dibuka.
StatusExtractFiles=Menyediakan fail pemasangan...
WizardPreparing=Menyediakan pemasangan
PreparingDesc=Pemasang sedang bersedia untuk memasang MAX Kiosk Server.
FinishedHeadingLabel=Pemasangan MAX Kiosk Server
FinishedLabelNoIcons=Pemasangan MAX Kiosk Server selesai.
FinishedLabel=Pemasangan MAX Kiosk Server selesai.
ClickFinish=Tekan Selesai untuk menutup pemasang.
ErrorTitle=Ralat
SetupFileMissing=Fail %1 tiada dalam folder pemasangan.
AboutSetupMenuItem=&Mengenai pemasang...
AboutSetupTitle=Mengenai pemasang
AboutSetupMessage=%1 versi %2%n%3

[CustomMessages]
english.MigratePageTitle=Pindah data dari pemasangan lama
english.MigratePageDesc=Pilihan. Biarkan kosong jika ini pemasangan baharu.
english.MigratePageLabel=Jika MAXCOM lama ada pada komputer ini, pilih folder datanya supaya data surau dipindahkan. Biarkan kosong untuk melangkau.
english.MigrateBrowse=Pilih...
english.MigrateBrowseTitle=Pilih folder data MAXCOM yang lama
english.BadValue=Nilai untuk %1 tidak sah: tidak boleh mengandungi tanda petikan atau baris baharu.
english.BadKiosk=Nilai untuk /KIOSK tidak sah. Gunakan khas, kongsi atau tiada.
english.RunFailed=Pemasangan MAX Kiosk Server tidak selesai. Kod keluar: %1.%n%nLihat mesej dalam tetingkap konsol, betulkan masalah yang dinyatakan, kemudian jalankan pemasang ini sekali lagi. Data surau tidak dibuang.
english.RunNoStart=Pemasangan MAX Kiosk Server tidak dapat dimulakan (%1).%n%nJalankan pemasang ini sekali lagi.
english.FinishedOk=MAX Kiosk Server sudah dipasang. Tekan Selesai untuk menutup pemasang.
english.RunDirExists=Folder kerja pemasangan sudah wujud: %1.%n%nPemasangan dihentikan demi keselamatan. Jalankan pemasang ini sekali lagi.
english.RunDirCreate=Folder kerja pemasangan tidak dapat dibuat: %1.%n%nPemasangan dihentikan. Jalankan pemasang ini sekali lagi.
english.RunDirLock=Folder kerja pemasangan tidak dapat dikunci kepada pentadbir (%1).%n%nPemasangan dihentikan demi keselamatan. Jalankan pemasang ini sekali lagi.
english.RunDirNotEmpty=Folder kerja pemasangan tidak kosong selepas dikunci.%n%nPemasangan dihentikan demi keselamatan. Jalankan pemasang ini sekali lagi.
english.FinishedFail=Pemasangan MAX Kiosk Server TIDAK selesai. Lihat mesej dalam tetingkap konsol, betulkan masalah itu dan jalankan pemasang ini sekali lagi.

[Files]
Source: "{#BundleDir}\*"; DestDir: "{code:GetRunDir}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Code]
var
  MigratePage: TWizardPage;
  MigrateEdit: TNewEdit;
  MigrateBrowseBtn: TNewButton;
  RunDone: Boolean;
  RunOk: Boolean;
  RunText: String;
  RunDir: String;
  RunDirCreated: Boolean;
  SetupExitCode: Integer;

type
  TGuid4 = record
    A, B, C, D: Cardinal;
  end;

function CoCreateGuid(var Guid: TGuid4): Integer;
external 'CoCreateGuid@ole32.dll stdcall';

// Lower-case hex of a 32-bit value, 8 digits.
function Hex8(V: Cardinal): String;
var
  I: Integer;
  Digits: String;
begin
  Digits := '0123456789abcdef';
  Result := '';
  for I := 1 to 8 do
  begin
    Result := Copy(Digits, Integer(V and 15) + 1, 1) + Result;
    V := V shr 4;
  end;
end;

// 32 random hex digits from a new GUID (CoCreateGuid). Empty when the call fails.
function RandomSuffix: String;
var
  G: TGuid4;
begin
  Result := '';
  G.A := 0; G.B := 0; G.C := 0; G.D := 0;
  if CoCreateGuid(G) <> 0 then Exit;
  Result := Hex8(G.A) + Hex8(G.B) + Hex8(G.C) + Hex8(G.D);
end;

function GetRunDir(Param: String): String;
begin
  Result := RunDir;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := SetupExitCode;
end;

procedure FailRun(Code: Integer);
begin
  if Code = 0 then Code := 1;
  SetupExitCode := Code;
end;

// True when the folder holds nothing (ignoring . and ..).
function FolderIsEmpty(const Dir: String): Boolean;
var
  Rec: TFindRec;
begin
  Result := True;
  if FindFirst(Dir + '\*', Rec) then
  begin
    try
      repeat
        if (Rec.Name <> '.') and (Rec.Name <> '..') then
        begin
          Result := False;
          Exit;
        end;
      until not FindNext(Rec);
    finally
      FindClose(Rec);
    end;
  end;
end;

// A value is unsafe when it holds a double quote or a line break. Nothing else is put on the command line.
function IsBadValue(const S: String): Boolean;
begin
  Result := (Pos('"', S) > 0) or (Pos(#13, S) > 0) or (Pos(#10, S) > 0);
end;

function SwitchGiven(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/' + Name) = 0 then
    begin
      Result := True;
      Exit;
    end;
end;

// Quote a validated value. A trailing backslash would escape the closing quote, so a dot is added.
function QuoteArg(const S: String): String;
var
  V: String;
begin
  V := S;
  if (Length(V) > 0) and (V[Length(V)] = '\') then V := V + '.';
  Result := '"' + V + '"';
end;

function CheckValue(const Name, Value: String): Boolean;
begin
  Result := not IsBadValue(Value);
  if not Result then
    SuppressibleMsgBox(FmtMessage(CustomMessage('BadValue'), [Name]), mbError, MB_OK, IDOK);
end;

function CheckKiosk(const Value: String): Boolean;
begin
  Result := (Value = '') or (CompareText(Value, 'khas') = 0) or (CompareText(Value, 'kongsi') = 0) or (CompareText(Value, 'tiada') = 0);
  if not Result then
    SuppressibleMsgBox(CustomMessage('BadKiosk'), mbError, MB_OK, IDOK);
end;

function InitializeSetup(): Boolean;
var
  Suffix: String;
begin
  RunDirCreated := False;
  SetupExitCode := 0;
  Suffix := RandomSuffix;
  RunDir := '';
  if Suffix = '' then
  begin
    SetupExitCode := 1;
    SuppressibleMsgBox(FmtMessage(CustomMessage('RunDirCreate'), ['GUID']), mbError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;
  RunDir := ExpandConstant('{commonappdata}') + '\MAXCOM-setup-' + Suffix;
  Result := CheckValue('/MIGRATEFROM', ExpandConstant('{param:MIGRATEFROM|}'))
        and CheckValue('/SURAU', ExpandConstant('{param:SURAU|}'))
        and CheckValue('/KIOSK', ExpandConstant('{param:KIOSK|}'))
        and CheckKiosk(ExpandConstant('{param:KIOSK|}'))
        and CheckValue('/DATADIR', ExpandConstant('{param:DATADIR|}'))
        and CheckValue('/CLOUDURL', ExpandConstant('{param:CLOUDURL|}'));
end;

procedure MigrateBrowseClick(Sender: TObject);
var
  Dir: String;
begin
  Dir := MigrateEdit.Text;
  if BrowseForFolder(CustomMessage('MigrateBrowseTitle'), Dir, False) then
    MigrateEdit.Text := Dir;
end;

procedure InitializeWizard();
var
  Lbl: TNewStaticText;
begin
  RunDone := False;
  RunOk := False;
  RunText := '';
  MigratePage := CreateCustomPage(wpWelcome, CustomMessage('MigratePageTitle'), CustomMessage('MigratePageDesc'));
  Lbl := TNewStaticText.Create(MigratePage);
  Lbl.Parent := MigratePage.Surface;
  Lbl.Left := 0;
  Lbl.Top := 0;
  Lbl.Width := MigratePage.SurfaceWidth;
  Lbl.AutoSize := False;
  Lbl.WordWrap := True;
  Lbl.Height := ScaleY(48);
  Lbl.Caption := CustomMessage('MigratePageLabel');
  MigrateEdit := TNewEdit.Create(MigratePage);
  MigrateEdit.Parent := MigratePage.Surface;
  MigrateEdit.Left := 0;
  MigrateEdit.Top := Lbl.Top + Lbl.Height + ScaleY(8);
  MigrateEdit.Width := MigratePage.SurfaceWidth - ScaleX(96);
  MigrateEdit.Text := '';
  MigrateBrowseBtn := TNewButton.Create(MigratePage);
  MigrateBrowseBtn.Parent := MigratePage.Surface;
  MigrateBrowseBtn.Left := MigrateEdit.Left + MigrateEdit.Width + ScaleX(8);
  MigrateBrowseBtn.Top := MigrateEdit.Top - ScaleY(1);
  MigrateBrowseBtn.Width := ScaleX(88);
  MigrateBrowseBtn.Height := ScaleY(23);
  MigrateBrowseBtn.Caption := CustomMessage('MigrateBrowse');
  MigrateBrowseBtn.OnClick := @MigrateBrowseClick;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (MigratePage <> nil) and (PageID = MigratePage.ID) then
    Result := ExpandConstant('{param:MIGRATEFROM|}') <> '';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (MigratePage <> nil) and (CurPageID = MigratePage.ID) then
  begin
    MigrateEdit.Text := Trim(MigrateEdit.Text);
    Result := CheckValue('-MigrateFrom', MigrateEdit.Text);
  end;
end;

// Builds the setup.ps1 argument list from validated values only.
function BuildArgs(var Err: String): String;
var
  Migrate, Surau, Kiosk, DataDir, CloudUrl: String;
begin
  Err := '';
  Migrate := ExpandConstant('{param:MIGRATEFROM|}');
  if Migrate = '' then Migrate := MigrateEdit.Text;
  Surau := ExpandConstant('{param:SURAU|}');
  Kiosk := ExpandConstant('{param:KIOSK|}');
  DataDir := ExpandConstant('{param:DATADIR|}');
  CloudUrl := ExpandConstant('{param:CLOUDURL|}');
  if IsBadValue(Migrate) or IsBadValue(Surau) or IsBadValue(Kiosk) or IsBadValue(DataDir) or IsBadValue(CloudUrl) then
  begin
    Err := 'nilai tidak sah';
    Result := '';
    Exit;
  end;
  if not ((Kiosk = '') or (CompareText(Kiosk, 'khas') = 0) or (CompareText(Kiosk, 'kongsi') = 0) or (CompareText(Kiosk, 'tiada') = 0)) then
  begin
    Err := 'nilai /KIOSK tidak sah';
    Result := '';
    Exit;
  end;
  Result := '-NoProfile -ExecutionPolicy Bypass -File ' + QuoteArg(RunDir + '\setup\setup.ps1');
  if not WizardSilent then Result := Result + ' -PauseAtEnd';
  if Migrate <> '' then Result := Result + ' -MigrateFrom ' + QuoteArg(Migrate);
  if Surau <> '' then Result := Result + ' -Surau ' + QuoteArg(Surau);
  if Kiosk <> '' then Result := Result + ' -Kiosk ' + QuoteArg(LowerCase(Kiosk));
  if DataDir <> '' then Result := Result + ' -DataDir ' + QuoteArg(DataDir);
  if CloudUrl <> '' then Result := Result + ' -CloudUrl ' + QuoteArg(CloudUrl);
  if SwitchGiven('YES') then Result := Result + ' -Yes';
end;

// Runs before the files are copied: makes the run folder fresh, locks it, and aborts on any doubt.
procedure PrepareRunDir;
var
  ResultCode: Integer;
begin
  if DirExists(RunDir) then
  begin
    FailRun(0);
    SuppressibleMsgBox(FmtMessage(CustomMessage('RunDirExists'), [RunDir]), mbError, MB_OK, IDOK);
    Abort;
  end;
  if not CreateDir(RunDir) then
  begin
    FailRun(0);
    SuppressibleMsgBox(FmtMessage(CustomMessage('RunDirCreate'), [RunDir]), mbError, MB_OK, IDOK);
    Abort;
  end;
  RunDirCreated := True;
  ResultCode := -1;
  if (not Exec(ExpandConstant('{sys}\icacls.exe'), '"' + RunDir + '" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    FailRun(ResultCode);
    SuppressibleMsgBox(FmtMessage(CustomMessage('RunDirLock'), [IntToStr(ResultCode)]), mbError, MB_OK, IDOK);
    Abort;
  end;
  if not FolderIsEmpty(RunDir) then
  begin
    FailRun(0);
    SuppressibleMsgBox(CustomMessage('RunDirNotEmpty'), mbError, MB_OK, IDOK);
    Abort;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Args, Err: String;
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    PrepareRunDir;
    Exit;
  end;
  if CurStep <> ssPostInstall then Exit;
  RunDone := True;
  RunOk := False;
  Args := BuildArgs(Err);
  if Args = '' then
  begin
    FailRun(0);
    SuppressibleMsgBox(FmtMessage(CustomMessage('RunNoStart'), [Err]), mbError, MB_OK, IDOK);
    Exit;
  end;
  ResultCode := -1;
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Args, RunDir, SW_SHOW, ewWaitUntilTerminated, ResultCode) then
  begin
    FailRun(0);
    SuppressibleMsgBox(FmtMessage(CustomMessage('RunNoStart'), [SysErrorMessage(ResultCode)]), mbError, MB_OK, IDOK);
    Exit;
  end;
  if ResultCode <> 0 then
  begin
    FailRun(ResultCode);
    SuppressibleMsgBox(FmtMessage(CustomMessage('RunFailed'), [IntToStr(ResultCode)]), mbError, MB_OK, IDOK);
    Exit;
  end;
  RunOk := True;
end;

// Remove only the folder this run created.
procedure DeinitializeSetup();
begin
  if RunDirCreated and (RunDir <> '') then
    DelTree(RunDir, True, True, True);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    if RunDone and RunOk then
      WizardForm.FinishedLabel.Caption := CustomMessage('FinishedOk')
    else
      WizardForm.FinishedLabel.Caption := CustomMessage('FinishedFail');
  end;
end;
