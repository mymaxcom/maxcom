allprojects {
    repositories {
        google()
        mavenCentral()
        // RootEncoder (Apache-2.0) is published on JitPack only, not Maven
        // Central. The filter keeps every other dependency off JitPack.
        maven("https://jitpack.io") {
            content { includeGroup("com.github.pedroSG94.RootEncoder") }
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

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
