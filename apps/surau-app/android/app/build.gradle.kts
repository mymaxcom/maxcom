import java.io.FileInputStream
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
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
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

gradle.taskGraph.whenReady {
    val wantsRelease = allTasks.any { it.name.contains("Release") }
    if (wantsRelease && !keystorePropertiesFile.exists()) {
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
