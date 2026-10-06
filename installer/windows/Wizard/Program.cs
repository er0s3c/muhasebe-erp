using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace MuhasebeERP.Setup;
public static class Program {
  [STAThread] public static int Main() {
    var app = new Application(); var window = new SetupWindow(); app.Run(window); return window.Completed ? 0 : 1602;
  }
}

public sealed class SetupWindow : Window {
  readonly string[] steps = ["Bilgisayar kontrolü", "Kullanım biçimi", "Lisans", "Firma ve yönetici", "Yedekleme", "Kurulum", "Tamamlandı"];
  readonly StackPanel body = new() { Margin = new Thickness(28) };
  readonly TextBlock heading = new() { FontSize = 26, FontWeight = FontWeights.SemiBold };
  readonly TextBlock subtitle = new() { Margin = new Thickness(0,8,0,20), TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DimGray };
  readonly Button next = new() { Content = "Devam", MinWidth = 130, Padding = new Thickness(18,10,18,10) };
  readonly Button back = new() { Content = "Geri", MinWidth = 90, Padding = new Thickness(12,10,12,10), Margin = new Thickness(0,0,10,0) };
  readonly ComboBox access = new() { ItemsSource = new[] { "Yalnızca bu bilgisayar", "Ofis ağı" }, SelectedIndex = 0, MinHeight = 36 };
  readonly TextBox firm = new(), name = new(), email = new(), backup = new() { Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "MuhasebeERP", "backups") };
  readonly PasswordBox code = new(), password = new();
  readonly TextBox progress = new() { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MinHeight = 240 };
  readonly TextBlock error = new() { Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0,12,0,0) };
  int step;
  bool busy;
  public bool Completed { get; private set; }
  string launchUrl = "http://127.0.0.1:3000";
  public SetupWindow() {
    Title = "Muhasebe ERP · Kurulum ve bakım"; Width = 740; Height = 640; MinWidth = 560; MinHeight = 520; WindowStartupLocation = WindowStartupLocation.CenterScreen; Background = new SolidColorBrush(Color.FromRgb(247,248,250));
    var layout = new DockPanel(); var footer = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(28,12,28,24) }; footer.Children.Add(back); footer.Children.Add(next); DockPanel.SetDock(footer,Dock.Bottom); layout.Children.Add(footer);
    layout.Children.Add(new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }); Content = layout;
    back.Click += (_,_) => { if (!busy && step > 0) { step--; Render(); } }; next.Click += async (_,_) => { try { await Advance(); } catch(Exception ex) { error.Text = ex.Message; busy = false; next.IsEnabled = true; back.IsEnabled = step > 0; } };
    Closing += (_,e) => { if (busy) { e.Cancel = true; error.Text = "Kurulumun güvenli biçimde tamamlanmasını bekleyin."; } };
    Render();
  }
  void Label(string text, Control field) { body.Children.Add(new TextBlock { Text = text, Margin = new Thickness(0,12,0,5) }); field.MinHeight = 36; body.Children.Add(field); }
  void Text(string text) => body.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0,8,0,8) });
  void Render() {
    body.Children.Clear(); heading.Text = steps[step]; subtitle.Text = $"Adım {step+1} / {steps.Length} · Verileriniz bu bilgisayarda tutulur."; body.Children.Add(heading); body.Children.Add(subtitle);
    back.IsEnabled = step > 0 && step < 6; next.Content = step == 5 ? "Kurulumu başlat" : step == 6 ? "Programı aç" : "Devam";
    if(step == 0) {
      Text($"Windows · {Environment.OSVersion.Version} · {(Environment.Is64BitOperatingSystem ? "64 bit" : "32 bit")}");
      Text("Docker veya terminal kullanmanız gerekmez. Program ve gerekli bileşenler otomatik kurulur. Windows yönetici izni gerekir.");
      Text("Ücretsiz dağıtımda Windows bilinmeyen yayıncı uyarısı gösterebilir. Dosyayı yalnızca satıcının resmi HTTPS adresinden indirin; güvenlik yazılımınızı kapatmayın.");
      var maintenance = new Button { Content = "Mevcut kurulumun bakımını aç", Padding = new Thickness(12), Margin = new Thickness(0,16,0,0) }; maintenance.Click += (_,_) => OpenMaintenance(); body.Children.Add(maintenance);
    } else if(step == 1) { Label("Nereden kullanacaksınız?",access); Text("Ofis ağı: HTTPS ve yalnızca özel ağ için erişim hazırlanır. Diğer bilgisayarlarda bağlantı yardımcısıyla sertifikayı doğrulayın."); }
    else if(step == 2) { Label("Satıcınızın verdiği lisans kodu",code); Text("İlk etkinleştirme için internet gerekir. Lisans süresi ve ek süre satıcınızın verdiği hakka göre gösterilir."); }
    else if(step == 3) { Label("Firma adı",firm); Label("Yönetici adı",name); Label("Yönetici e-postası",email); Label("Yönetici parolası",password); Text("En az 12 karakterli güçlü bir parola kullanın. Bu bilgiler destek günlüklerine yazılmaz."); }
    else if(step == 4) { Label("Yedeklerin tutulacağı klasör",backup); Text("Her gece 02:15’te otomatik yedek; son 14 yedek korunur. Yedeklerin ayrı diske de kopyalanması önerilir."); }
    else if(step == 5) { Text("Lisans doğrulanacak, ayrı veritabanı ve Windows hizmetleri hazırlanacak. Mevcut başka programların veritabanları kullanılmayacak."); body.Children.Add(progress); }
    else { Text("Kurulum tamamlandı. Program bilgisayar açıldığında otomatik başlar."); Text(launchUrl); if(access.SelectedIndex == 1) Text("Ofisteki diğer bilgisayarlara bağlanma kılavuzu veri klasöründe hazırlanmıştır."); }
    error.Text = ""; body.Children.Add(error);
  }
  async Task Advance() {
    if(busy) return;
    var server = (Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "InstallationType", "") as string)?.Contains("Server") == true;
    if(step == 0 && (!Environment.Is64BitOperatingSystem || Environment.OSVersion.Version.Build < (server ? 20348 : 22000))) throw new Exception("Windows 11 veya Windows Server 2022 ve üzeri gerekir.");
    if(step == 2 && string.IsNullOrWhiteSpace(code.Password)) throw new Exception("Lisans kodunu girin.");
    if(step == 3 && (string.IsNullOrWhiteSpace(firm.Text) || string.IsNullOrWhiteSpace(name.Text) || !email.Text.Contains('@') || password.Password.Length < 12)) throw new Exception("Firma, yönetici adı, geçerli e-posta ve en az 12 karakterli parola girin.");
    if(step == 4 && (!Path.IsPathFullyQualified(backup.Text) || backup.Text.IndexOfAny(['\r','\n']) >= 0)) throw new Exception("Yedekleme için tam bir klasör yolu seçin.");
    if(step == 5) { busy = true; next.IsEnabled = back.IsEnabled = false; await Install(); Completed = true; busy = false; next.IsEnabled = true; }
    if(step == 6) { Process.Start(new ProcessStartInfo(launchUrl) { UseShellExecute = true }); Close(); return; }
    step++; Render();
  }
  static void Protect(string path) {
    Directory.CreateDirectory(path); var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true,false);
    foreach(var sid in new[]{WellKnownSidType.BuiltinAdministratorsSid,WellKnownSidType.LocalSystemSid}) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid,null),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    new DirectoryInfo(path).SetAccessControl(acl);
  }
  async Task Install() {
    using var archive = Assembly.GetExecutingAssembly().GetManifestResourceStream("erp.kit.zip") ?? throw new Exception("Bu dosya arayüz test derlemesidir; müşteri için sürüm paketi gömülerek yeniden üretilmelidir.");
    var staging = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"MuhasebeERP","setup",Guid.NewGuid().ToString("N")); Protect(staging);
    progress.Text = "Kurulum paketi hazırlanıyor…\n";
    using(var zip = new ZipArchive(archive,ZipArchiveMode.Read)) {
      long total = 0; foreach(var entry in zip.Entries) {
        if(entry.FullName.Contains(':') || entry.FullName.Contains('\\')) throw new Exception("Paket içinde geçersiz Windows yolu.");
        total += entry.Length; if(total > 12L*1024*1024*1024 || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000) throw new Exception("Paket boyutu veya bağlantı girdisi geçersiz.");
        var target = Path.GetFullPath(Path.Combine(staging,entry.FullName)); if(!target.StartsWith(staging+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new Exception("Paket içinde geçersiz yol.");
        if(entry.FullName.EndsWith('/')) Directory.CreateDirectory(target); else { Directory.CreateDirectory(Path.GetDirectoryName(target)!); using var input = entry.Open(); using var output = File.Create(target); await input.CopyToAsync(output); }
      }
    }
    var roots = Directory.GetDirectories(staging).Where(d=>File.Exists(Path.Combine(d,"kit.json"))).ToArray(); if(roots.Length != 1) throw new Exception("Sürüm paketi bulunamadı.");
    var root = roots[0]; var answers = Path.Combine(staging,"answers.txt"); var setup = Path.Combine(staging,"owner.json");
    var port = 3000;
    var envFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "MuhasebeERP", "erp.env");
    if(File.Exists(envFile)) { var line = File.ReadLines(envFile).FirstOrDefault(l=>l.StartsWith("PORT=")); if(line != null && int.TryParse(line[5..],out var oldPort)) port = oldPort; }
    else { var used = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Select(p=>p.Port).ToHashSet(); while(used.Contains(port) && port < 3100) port++; if(port == 3100) throw new Exception("Uygulama için boş port bulunamadı."); }
    launchUrl = $"http://127.0.0.1:{port}";
    var owner = new { organizationName=firm.Text.Trim(),fullName=name.Text.Trim(),email=email.Text.Trim(),password=password.Password };
    await File.WriteAllTextAsync(setup,JsonSerializer.Serialize(owner),new UTF8Encoding(false));
    if(backup.Text.Contains('"') || code.Password.IndexOfAny(['\r','\n','"']) >= 0) throw new Exception("Girdi geçersiz karakter içeriyor.");
    await File.WriteAllTextAsync(answers,$"MODE=prod\nINSTALL_PATH=native\nACCESS=local\nPORT={port}\nDEMO=no\nREGISTRATION=no\nLICENSE_CODE=\"{code.Password}\"\nBACKUP_DIR=\"{backup.Text}\"\nBACKUP_KEEP=14\nBACKUP_TIME=02:15\n",new UTF8Encoding(false));
    var installer = Path.Combine(root,"installer","install.ps1");
    try {
      await Run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",installer,"-AnswersFile",answers,"-SetupOwnerFile",setup,"-DedicatedPostgres","-Yes"]);
      if(access.SelectedIndex == 1) { await Run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",Path.Combine(root,"installer","windows","office-network.ps1"),"-Mode","Enable"]); launchUrl = $"https://{Environment.MachineName.ToLowerInvariant()}:3443"; }
    } finally { if(File.Exists(answers)) File.Delete(answers); if(File.Exists(setup)) File.Delete(setup); code.Clear(); password.Clear(); }
  }
  async Task Run(string command,string[] args) {
    var start = new ProcessStartInfo(command) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8 }; foreach(var arg in args)start.ArgumentList.Add(arg);
    using var process = Process.Start(start) ?? throw new Exception("Kurulum işleyicisi başlatılamadı.");
    var readOut = Task.Run(async()=>{ while(await process.StandardOutput.ReadLineAsync() is string line) await Dispatcher.InvokeAsync(()=>{ progress.AppendText(line+"\n");progress.ScrollToEnd(); }); });
    // Never surface raw stderr: dependency tools can echo secrets in diagnostic text.
    var readErr = process.StandardError.ReadToEndAsync(); await Task.WhenAll(process.WaitForExitAsync(),readOut,readErr);
    if(process.ExitCode != 0) throw new Exception($"İşlem tamamlanamadı (kod {process.ExitCode}). Yukarıdaki aşamayı kontrol edip yeniden deneyin.");
  }
  void OpenMaintenance() {
    var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"MuhasebeERP");
    var window = new Window { Title="Muhasebe ERP · Bakım",Owner=this,Width=680,Height=650,WindowStartupLocation=WindowStartupLocation.CenterOwner };
    var panel = new StackPanel { Margin=new Thickness(24) }; panel.Children.Add(new TextBlock { Text="Kurulum durumu ve yedekleme",FontSize=22 });
    panel.Children.Add(new TextBlock { Text=File.Exists(Path.Combine(data,"erp.env"))?"Kurulum bulundu. Ayrıntılı sürüm, lisans ve yedek yönetimi programın Ayarlar bölümündedir.":"Bu bilgisayarda kurulum bulunamadı.",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,12,0,12) });
    var maintenanceUrl = File.Exists(Path.Combine(data,"launch-url.txt")) ? File.ReadAllText(Path.Combine(data,"launch-url.txt")).Trim() : launchUrl;
    foreach(var item in new[]{("Programı ve lisansı aç",maintenanceUrl),("Yedekleme ve güncellemeleri aç",maintenanceUrl+"/settings/backups")}) { var button=new Button{Content=item.Item1,Padding=new Thickness(10),Margin=new Thickness(0,5,0,5)};button.Click+=(_,_)=>Process.Start(new ProcessStartInfo(item.Item2){UseShellExecute=true});panel.Children.Add(button); }
    var result = new TextBox { IsReadOnly=true,TextWrapping=TextWrapping.Wrap,MinHeight=110,VerticalScrollBarVisibility=ScrollBarVisibility.Auto };
    var controls = new List<Button>();
    foreach(var item in new[]{("Hizmet ve sürüm durumunu göster","Status"),("Şimdi yedek al","Backup"),("Hizmetleri yeniden başlat","Restart"),("Kurulumu onar","Repair"),("Yedekten geri yükle","Restore"),("İmzalı çevrimdışı güncelleme","OfflineUpdate"),("Kişisel bilgileri içermeyen destek dosyası","Support")}) {
      var button = new Button { Content=item.Item1,Padding=new Thickness(10),Margin=new Thickness(0,4,0,4) }; controls.Add(button);panel.Children.Add(button);
      button.Click += async (_,_) => {
        string? file = null, manifest = null;
        if(item.Item2 is "Restore" or "OfflineUpdate") {
          var dialog = new Microsoft.Win32.OpenFileDialog { Title=item.Item1,Filter=item.Item2 == "Restore" ? "ERP yedeği|*.dump" : "Windows güncelleme paketi|*.zip" };if(dialog.ShowDialog(window) != true)return;file=dialog.FileName;
          if(item.Item2 == "OfflineUpdate") { var signed = new Microsoft.Win32.OpenFileDialog {Title="Satıcı imzalı manifestoyu seçin",Filter="İmzalı manifesto|*.txt;*.manifest"};if(signed.ShowDialog(window) != true)return;manifest=signed.FileName; }
          if(MessageBox.Show(window,item.Item2 == "Restore" ? "Mevcut veriler seçilen yedekteki duruma dönecek. Önce yeni bir yedek alınacaktır. Devam edilsin mi?" : "Satıcı imzası ve paket özeti doğrulanıp yedek alınacak, program güncellenecek. Devam edilsin mi?",item.Item1,MessageBoxButton.YesNo,MessageBoxImage.Warning) != MessageBoxResult.Yes)return;
        }
        foreach(var control in controls)control.IsEnabled=false;
        try {
          var args = new List<string>{"-NoProfile","-ExecutionPolicy","Bypass","-File",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"MuhasebeERP","current","installer","windows","maintenance.ps1"),"-Operation",item.Item2};
          if(file != null)args.AddRange(["-File",file,"-Confirmed"]);if(manifest != null)args.AddRange(["-Manifest",manifest]);
          var start=new ProcessStartInfo("powershell.exe"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};foreach(var arg in args)start.ArgumentList.Add(arg);
          using var process=Process.Start(start)!;var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();await Task.WhenAll(process.WaitForExitAsync(),output,errors);result.Text=process.ExitCode == 0 ? await output : $"Bakım işlemi tamamlanamadı (kod {process.ExitCode}). İlgili dosyayı ve hizmet durumunu kontrol edin.";
        } catch(Exception ex){result.Text=ex.Message;}finally{foreach(var control in controls)control.IsEnabled=true;}
      };
    }
    panel.Children.Add(result);window.Content=new ScrollViewer{Content=panel,VerticalScrollBarVisibility=ScrollBarVisibility.Auto};window.ShowDialog();
  }
}
