import java.io.FileInputStream
import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing: the operator keeps android/key.properties and the .jks
// outside git (see android/.gitignore). A release build without them fails
// with a readable message and never falls back to the debug key.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}

fun keystoreProperty(name: String): String =
    keystoreProperties.getProperty(name)
        ?: throw GradleException(
            "key.properties tiada nilai '$name'. Diperlukan: storeFile, storePassword, keyAlias, keyPassword (lihat android/key.properties.example)."
        )

// Plan 14 Task 24: the private MAXCOM Ops build. One switch drives both sides:
// the same --dart-define=MAXCOM_OPS=true the Dart code reads (the Flutter
// plugin hands every define to Gradle in the comma-separated, base64
// "dart-defines" property), so the package id and kOpsBuild cannot drift.
val isOpsBuild: Boolean =
    (project.findProperty("dart-defines") as String?)
        ?.split(",")
        ?.filter { it.isNotEmpty() }
        ?.map { String(Base64.getDecoder().decode(it), Charsets.UTF_8) }
        ?.any { it == "MAXCOM_OPS=true" } ?: false

// The ops key is its own file and its own keystore, never key.properties.
val opsKeystorePropertiesFile = rootProject.file("key-ops.properties")
val opsKeystoreProperties = Properties().apply {
    if (opsKeystorePropertiesFile.exists()) {
        FileInputStream(opsKeystorePropertiesFile).use { load(it) }
    }
}

fun opsKeystoreProperty(name: String): String =
    opsKeystoreProperties.getProperty(name)
        ?: throw GradleException(
            "key-ops.properties tiada nilai '$name'. Diperlukan: storeFile, storePassword, keyAlias, keyPassword (lihat android/key-ops.properties.example)."
        )

android {
    namespace = "my.maxcom.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "my.maxcom.app"
        minSdk = 26
        targetSdk = 35
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        if (isOpsBuild) {
            applicationIdSuffix = ".ops"
            manifestPlaceholders["appLabel"] = "MAXCOM Ops"
            manifestPlaceholders["appIcon"] = "@mipmap/ic_launcher_ops"
        } else {
            manifestPlaceholders["appLabel"] = "MAX Admin Client"
            manifestPlaceholders["appIcon"] = "@mipmap/ic_launcher"
        }
    }

    // The ops icon exists only in the ops build; the public build does not carry it.
    if (isOpsBuild) {
        sourceSets.getByName("main").res.srcDir("src/ops-res")
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = rootProject.file(keystoreProperty("storeFile"))
                storePassword = keystoreProperty("storePassword")
                keyAlias = keystoreProperty("keyAlias")
                keyPassword = keystoreProperty("keyPassword")
            }
        }
        create("ops") {
            if (opsKeystorePropertiesFile.exists()) {
                storeFile = rootProject.file(opsKeystoreProperty("storeFile"))
                storePassword = opsKeystoreProperty("storePassword")
                keyAlias = opsKeystoreProperty("keyAlias")
                keyPassword = opsKeystoreProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName(if (isOpsBuild) "ops" else "release")
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

// rtsp-client-android 6.1.3 (RTSP over UDP exists from 6.1.0; releases from 5.6.5 on)
// built against compileSdk 37 and so declares minCompileSdk 37 in its AAR metadata, but the Android Gradle Plugin in use
// (9.1.0) tops out at compileSdk 36 and platform 37 is not installed. The library has minSdk 24 and runs on the device
// API, so the app stays on compileSdk 36 and only this check is skipped. Remove it when the toolchain moves to 37.
tasks.configureEach {
    if (name.startsWith("check") && name.endsWith("AarMetadata")) enabled = false
}

gradle.taskGraph.whenReady {
    val wantsRelease = allTasks.any { it.name.contains("Release") }
    if (wantsRelease && isOpsBuild && !opsKeystorePropertiesFile.exists()) {
        throw GradleException(
            "key-ops.properties tiada: ${opsKeystorePropertiesFile.path} tidak dijumpai. " +
                "Binaan MAXCOM Ops ditandatangani dengan kunci ops sahaja (lihat android/key-ops.properties.example); " +
                "tidak sekali-kali dengan kunci awam atau kunci nyahpepijat. " +
                "(Ops release build refused: key-ops.properties not found.)"
        )
    }
    if (wantsRelease && !isOpsBuild && !keystorePropertiesFile.exists()) {
        throw GradleException(
            "key.properties tiada: ${keystorePropertiesFile.path} tidak dijumpai. " +
                "Buat fail itu daripada keystore pengendali (lihat android/key.properties.example); " +
                "APK keluaran tidak sekali-kali ditandatangani dengan kunci nyahpepijat. " +
                "(Release build refused: key.properties not found.)"
        )
    }
}

dependencies {
    implementation("androidx.biometric:biometric:1.1.0")
    // Live publisher (Plan 5, Task 10). Pinned exactly; licence Apache-2.0,
    // recorded in android/THIRD-PARTY.md. JitPack repo: see build.gradle.kts.
    implementation("com.github.pedroSG94.RootEncoder:library:2.8.1")
    // RTSP pull client for the external camera (live external source, K1).
    // Pinned exactly; licence Apache-2.0, recorded in android/THIRD-PARTY.md.
    implementation("com.github.alexeyvasilyev:rtsp-client-android:6.1.3")
    // Catch-up upload worker (Plan 6, Task 10). Pinned exactly; licence
    // Apache-2.0, recorded in android/THIRD-PARTY.md.
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    testImplementation("junit:junit:4.13.2")
    // org.json is a stub in unit tests; the real library lets the job
    // parsing be tested off the device (test scope only).
    testImplementation("org.json:json:20240303")
}

flutter {
    source = "../.."
}
