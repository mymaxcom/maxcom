allprojects {
    repositories {
        google()
        mavenCentral()
        // RootEncoder (Apache-2.0) is published on JitPack only, not Maven
        // Central (as is the RTSP client, group com.github.alexeyvasilyev). The filter
        // keeps every other dependency off JitPack.
        maven("https://jitpack.io") {
            content {
                includeGroup("com.github.pedroSG94.RootEncoder")
                includeGroup("com.github.alexeyvasilyev")
            }
        }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Third-party Flutter plugins ship their own unit tests (image_picker_android fails 11 of 110 here, on the base too).
// They are not ours and must not stop a full `testDebugUnitTest` run before the app's own tests: only `:app` runs tests.
subprojects {
    if (project.name != "app") {
        tasks.withType<Test>().configureEach { enabled = false }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
