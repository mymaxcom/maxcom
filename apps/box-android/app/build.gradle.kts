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
// The requested names also hold option values such as --tests "ReleaseStoreTest": drop every argument that starts
// with '--' and the value that follows it, and anything with '*' or '.' (a test filter), so only task names remain.
val requestedTasks: List<String> = run {
    val names = gradle.startParameter.taskNames
    names.filterIndexed { i, t ->
        !t.startsWith("--") && !(i > 0 && names[i - 1].startsWith("--")) && t.none { it == '*' || it == '.' }
    }
}
val wantsRelease = requestedTasks.any { it.contains("Release", ignoreCase = true) }
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

// Internal build of the same public version (builds.json, 0 to 9; -PboxBuild=): a box with the first build accepts the next.
val boxBuild: Int = ((findProperty("boxBuild") as String?)?.toIntOrNull() ?: 0).also {
    if (it !in 0..9) throw GradleException("boxBuild mesti 0 hingga 9, diberi: $it")
}

// versionCode = ((YY * 10000 + MM * 100 + N) * 100) + build * 10 + index; index 1 = armeabi-v7a APK, 2 = arm64-v8a APK,
// 3 = the Google Play app bundle (one code for every ABI split Play makes from it). Same build: the bundle code is the
// highest of the three; the next build (build + 1) is always higher than all of them. Example 2026.11.13 b2: APKs
// 26111321 and 26111322, bundle 26111323 (b1 was 26111311 and 26111312).
val baseCode: Int = versionMatch?.let { m ->
    val (year, month, n) = m.destructured
    (year.toInt() % 100) * 10000 + month.toInt() * 100 + n.toInt()
} ?: 0
val abiIndex = mapOf("armeabi-v7a" to 1, "arm64-v8a" to 2)
val bundleIndex = 3

// A bundle is built in its own Gradle run: Play cuts the ABI splits itself, and the APK-only abi splits below are
// switched off for it. Asking for an APK task and a bundle task together would give APKs without the splits.
fun lastSegment(task: String) = task.substringAfterLast(':')
val wantsBundle = requestedTasks.any { lastSegment(it).startsWith("bundle", ignoreCase = true) }
val wantsApk = requestedTasks.any {
    val t = lastSegment(it)
    t.startsWith("assemble", ignoreCase = true) || t.startsWith("install", ignoreCase = true)
}
if (wantsBundle && wantsApk) {
    throw GradleException(
        "Jangan jalankan tugas APK (assemble/install) dan tugas bundle dalam satu larian Gradle. " +
            "(Run assemble* and bundle* in separate Gradle invocations: the per-ABI splits apply to APKs only.)"
    )
}

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
        // The bundle's code (no ABI filter). The per-ABI APK outputs override it in androidComponents below.
        versionCode = maxOf(baseCode * 100 + boxBuild * 10 + bundleIndex, 1)
        versionName = boxVersion
    }

    // One APK per ABI, no universal APK (plan decision 3). Off for a bundle: Play makes the ABI splits from the .aab.
    splits {
        abi {
            isEnable = !wantsBundle
            reset()
            include("armeabi-v7a", "arm64-v8a")
            isUniversalApk = false
        }
    }

    // App bundle (Google Play): the device gets only its own ABI's libraries.
    bundle {
        abi {
            enableSplit = true
        }
    }

    packaging {
        jniLibs {
            // node, mediamtx and ffmpeg ship as lib*.so and are EXECUTED from nativeLibraryDir, so they must be
            // extracted to disk at install. useLegacyPackaging = true does that for both outputs: AGP writes
            // android:extractNativeLibs="true" into the merged manifest (same as the source manifest) and leaves
            // the bundle's uncompressNativeLibraries setting off, so Play delivers the libraries compressed and
            // the installer extracts them. The bytes must stay those of the pins.
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

// Per-ABI version code and file name MAX-Kiosk-Server-<version>[-b<build>]-<abi>.apk (plan decision 3; the build is in the name when above 0).
// With the abi splits off (a bundle) no output has an ABI filter: it keeps the bundle code from defaultConfig.
androidComponents {
    onVariants { variant ->
        variant.outputs.forEach { output ->
            val abi = output.filters
                .firstOrNull { it.filterType == FilterConfiguration.FilterType.ABI }
                ?.identifier
            val index = abiIndex[abi] ?: return@forEach
            output.versionCode.set(maxOf(baseCode * 100 + boxBuild * 10 + index, 1))
            val suffix = if (variant.buildType == "release") "" else "-${variant.buildType}"
            (output as VariantOutputImpl).outputFileName.set("MAX-Kiosk-Server-$boxVersion${if (boxBuild > 0) "-b$boxBuild" else ""}-$abi$suffix.apk")
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
