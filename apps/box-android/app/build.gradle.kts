import com.android.build.api.variant.FilterConfiguration
import com.android.build.api.variant.impl.VariantOutputImpl
import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: the operator keeps key.properties and the .jks outside git
// (see .gitignore). A release build without them fails with a readable message
// and never falls back to the debug key.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}

fun keystoreProperty(name: String): String =
    keystoreProperties.getProperty(name)
        ?: throw GradleException(
            "key.properties tiada nilai '$name'. Diperlukan: storeFile, storePassword, keyAlias, keyPassword (lihat key.properties.example)."
        )

// Box version YYYY.MM.N from -PboxVersion=. A release build without it fails; debug uses 0.0.0.
val wantsRelease = gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }
val boxVersion: String = (findProperty("boxVersion") as String?)
    ?: if (wantsRelease) {
        throw GradleException("boxVersion tiada: beri -PboxVersion=YYYY.MM.N untuk binaan keluaran. (Release build needs -PboxVersion.)")
    } else {
        "0.0.0"
    }

val versionMatch = Regex("""^(\d{4})\.(\d{1,2})\.(\d{1,2})$""").matchEntire(boxVersion)
if (versionMatch == null && boxVersion != "0.0.0") {
    throw GradleException("boxVersion '$boxVersion' bukan bentuk YYYY.MM.N (N paling tinggi 99).")
}

// versionCode = ((YY * 10000 + MM * 100 + N) * 10) + abi; abi 1 = armeabi-v7a, 2 = arm64-v8a.
val baseCode: Int = versionMatch?.let { m ->
    val (year, month, n) = m.destructured
    (year.toInt() % 100) * 10000 + month.toInt() * 100 + n.toInt()
} ?: 0
val abiIndex = mapOf("armeabi-v7a" to 1, "arm64-v8a" to 2)

android {
    namespace = "my.maxcom.box"
    compileSdk = 35

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "my.maxcom.box"
        minSdk = 28
        targetSdk = 35
        versionCode = maxOf(baseCode * 10, 1)
        versionName = boxVersion
    }

    // One APK per ABI, no universal APK (plan decision 3).
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a")
            isUniversalApk = false
        }
    }

    packaging {
        jniLibs {
            // Libraries are extracted to nativeLibraryDir at install; the bytes must stay those of the pins.
            useLegacyPackaging = true
            keepDebugSymbols += "**/*.so"
        }
    }

    // The box release archive travels in the assets as .tar.gz and must not be re-compressed.
    androidResources {
        noCompress += listOf("gz", "tgz")
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

// Per-ABI version code and file name MAX-Kiosk-Server-<version>-<abi>.apk (plan decision 3).
androidComponents {
    onVariants { variant ->
        variant.outputs.forEach { output ->
            val abi = output.filters
                .firstOrNull { it.filterType == FilterConfiguration.FilterType.ABI }
                ?.identifier
            val index = abiIndex[abi] ?: return@forEach
            output.versionCode.set(maxOf(baseCode * 10 + index, 1))
            val suffix = if (variant.buildType == "release") "" else "-${variant.buildType}"
            (output as VariantOutputImpl).outputFileName.set("MAX-Kiosk-Server-$boxVersion-$abi$suffix.apk")
        }
    }
}

gradle.taskGraph.whenReady {
    val releaseRequested = allTasks.any { it.name.contains("Release") }
    if (releaseRequested && !keystorePropertiesFile.exists()) {
        throw GradleException(
            "key.properties tiada: ${keystorePropertiesFile.path} tidak dijumpai. " +
                "Buat fail itu daripada keystore pengendali (lihat key.properties.example); " +
                "APK keluaran tidak sekali-kali ditandatangani dengan kunci nyahpepijat. " +
                "(Release build refused: key.properties not found.)"
        )
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    // org.json is a stub in unit tests; the real library lets JSON code be tested off the device.
    testImplementation("org.json:json:20240303")
}
