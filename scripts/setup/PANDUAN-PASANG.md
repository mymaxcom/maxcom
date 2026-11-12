# Pasang MAX Kiosk Server pada PC Windows

Panduan ini untuk sukarelawan surau. MAX Kiosk Server ialah perisian kotak MAXCOM yang sama pada Windows dan Android; di Windows nama folder dan menu Start kekal MAXCOM. Masa yang diperlukan: kira-kira 20 minit. Tangkapan skrin akan ditambah selepas ujian di PC sebenar.

## 1. Apa yang anda perlukan

- PC Windows 10 atau 11 (64-bit), RAM 4 GB, ruang kosong 32 GB.
- TV atau monitor untuk skrin surau.
- Rangkaian Wi-Fi atau kabel surau.
- Akaun pentadbir Windows (anda akan diminta menekan Yes sekali).

## 2. Muat turun

Cara biasa ialah fail `.exe`. Fail `.zip` ialah cara lain (lihat hujung bahagian 3).

1. Muat turun fail `MAX-Kiosk-Server-Setup-<versi>-windows.exe` dari laman MAXCOM (mymaxcom.my). Fail `.sha256` dengan nama yang sama ada di sebelahnya.
2. Semak fail itu tidak rosak atau diubah. Buka PowerShell di folder Downloads dan jalankan:

   ```
   Get-FileHash .\MAX-Kiosk-Server-Setup-<versi>-windows.exe -Algorithm SHA256
   ```

   Bandingkan kod `Hash` yang keluar dengan kod dalam fail `.sha256` atau yang disiarkan di laman itu. Kedua-duanya mesti sama. Jika berbeza, jangan jalankan fail itu dan muat turun semula.

## 3. Pasang

1. Klik dua kali fail `.exe`.
2. Windows bertanya `Do you want to allow this app to make changes to your device?` (UAC). Tekan `Yes`. Pemasang ini perlu hak pentadbir.
3. Pemasang ini belum ditandatangani, jadi Windows SmartScreen mungkin memaparkan `Windows protected your PC`. Tekan `Maklumat lanjut` (`More info`), kemudian tekan `Jalankan juga` (`Run anyway`). Langkah ini hanya perlu kerana pemasang belum ditandatangani; teruskan hanya jika kod SHA-256 pada bahagian 2 sepadan.
4. Ikut tetingkap pemasang (semua dalam Bahasa Melayu). Jika ada kotak MAXCOM lama pada PC ini, pilih folder datanya pada halaman pertama; jika tidak, biarkan kosong dan tekan `Seterusnya`, kemudian `Pasang`.
5. Satu tetingkap konsol dibuka. Jawab tiga soalan di dalamnya:
   - `Nama pendek surau`: nama surau anda.
   - Alamat PC ini pada rangkaian surau: jika ada lebih satu alamat, pilih nombornya. Pilih alamat rangkaian surau (nombor yang sama dengan telefon dan iPad di surau).
   - `Jenis skrin`: `khas` (PC khas untuk TV, skrin bermula sendiri), `kongsi` (PC dikongsi, skrin dibuka dari menu Start sahaja) atau `tiada` (tiada skrin).
6. Tunggu. Setiap langkah mencetak satu baris yang bermula dengan `OK`. Jika ada baris `GAGAL:`, baca sebabnya, betulkan, kemudian jalankan fail `.exe` sekali lagi. Data surau tidak dibuang. Jangan tutup tetingkap konsol sehingga selesai.
7. Pemasangan siap apabila anda nampak `Pemasangan MAX Kiosk Server selesai.` diikuti `Alamat kotak:` dan lokasi fail sijil akar. Pemasang menyalin fail sementaranya ke satu folder khas di bawah `C:\ProgramData` yang hanya boleh dibuka oleh pentadbir, dan membuangnya selepas selesai.

### Cara lain: fail zip

Jika `.exe` tidak boleh digunakan pada PC anda, muat turun `MAX-Kiosk-Server-Setup-<versi>-windows.zip` dan semak kod SHA-256 dengan cara yang sama. Klik kanan fail zip, pilih `Properties`, tanda `Unblock`, tekan `OK`. Klik kanan sekali lagi, pilih `Extract All`. Buka folder yang terhasil, klik kanan `Pasang MAXCOM`, pilih `Run as administrator` dan tekan `Yes`. Soalan dan langkah selepas itu sama seperti nombor 5 hingga 7 di atas.

Memasang semula dengan jawapan yang sama selamat: langkah yang sudah siap dicetak sebagai `OK ... sudah siap`.

## 4. Daftar telefon pertama

Imbas kod QR pada skrin dengan aplikasi MAXCOM. Pada telefon atau iPad yang belum percaya kotak, pasang fail sijil akar yang dinyatakan pada baris `Fail sijil akar` dahulu.

## 5. Tetapan yang perlu dibuat sekali

Setiap tetapan ini ialah pilihan surau. Semuanya dibuat pada PC atau router, bukan oleh MAXCOM.

1. Alamat IP tetap: pada router surau, tetapkan alamat yang sama sentiasa untuk PC ini (DHCP reservation). Jika alamat bertukar, telefon tidak dapat sambung dan sijil kotak perlu dibuat semula.
2. BIOS: tetapkan PC hidup semula selepas bekalan elektrik pulih (pilihan seperti `AC Power Recovery` atau `Restore on AC Power Loss`).
3. Log masuk automatik untuk PC khas: gunakan akaun Windows biasa tanpa hak pentadbir, khas untuk skrin. Buka `netplwiz` atau gunakan alat Autologon Microsoft. Sesiapa yang menghidupkan PC akan masuk ke akaun itu, jadi akaun itu tidak boleh ada hak pentadbir. Kotak MAXCOM sendiri bermula sebelum sesiapa log masuk.
4. Waktu aktif Windows Update: tetapkan di luar waktu solat supaya PC tidak dimulakan semula ketika azan.

## 6. Semak MAXCOM

Buka menu Start, folder MAXCOM, pilih `Semak MAXCOM`. Ia hanya membaca, tidak mengubah apa-apa. Gunakan selepas pasang, selepas PC dimulakan semula atau bila ada masalah.

- Baris `OK` bermakna semakan itu lulus.
- Baris `GAGAL:` bermakna ada yang tidak kena; teks selepasnya menyatakan apa.
- Baris `LANGKAU` bermakna semakan itu tidak dijalankan (contohnya skrin bukan mod `khas`).
- Baris akhir `Semak MAXCOM: semua semakan yang dijalankan lulus.` bermakna semuanya baik.

## 7. Jika ada masalah

- Skrin kosong: jalankan `Semak MAXCOM`. Dari menu Start, buka `Skrin MAXCOM`. Untuk mod `khas`, log keluar dan masuk semula.
- Telefon tidak dapat sambung: kemungkinan alamat PC bertukar. Jalankan `Semak MAXCOM` dan lihat baris `health_https`; tetapkan alamat IP tetap (bahagian 5, nombor 1), kemudian jalankan `Pasang MAXCOM` semula dan pilih alamat yang betul.
- Siaran langsung tidak sampai ke TV: lihat baris `fw_webrtc`, `fw_srt` dan `tools` dalam `Semak MAXCOM`.
- Jika masih gagal, hubungi admin@mymaxcom.my dan sertakan baris `GAGAL:` yang anda nampak.

## 8. Pindah dari kotak lama yang dijalankan dengan tangan

Hanya untuk surau yang sudah ada kotak MAXCOM dijalankan dari folder pembangun. Jalankan `Pasang MAXCOM` dengan pilihan `-MigrateFrom <folder data lama>`. Skrip menunjukkan proses kotak lama dan meminta kebenaran sebelum menghentikannya. Folder lama tidak diubah. Jangan hidupkan kotak lama lagi selagi kotak yang dipasang ini berjalan.

## 9. Buang MAXCOM

Menu Start, folder MAXCOM, `Buang MAXCOM`. Perisian, tugas dan peraturan tembok api dibuang. Data surau dikekalkan: baris `KEKAL: data surau di ...` menunjukkan lokasinya (biasanya `C:\ProgramData\MAXCOM\data`), bersama salinan simpanan di `C:\ProgramData\MAXCOM\backups`. Sijil akar MAXCOM juga dikekalkan supaya telefon tidak perlu didaftar semula. Data hanya dibuang jika anda menjalankan dengan `-RemoveData` dan menaip `BUANG DATA` apabila diminta.
