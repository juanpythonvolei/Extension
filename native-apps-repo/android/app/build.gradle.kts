plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val continuumUrl = (project.findProperty("continuumUrl") as String?)?.trimEnd('/') ?: "https://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app"
val roomCode = (project.findProperty("roomCode") as String?) ?: "MESH01"

android {
    namespace = "app.continuum.mesh"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.continuum.mesh"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "1.2.0"

        buildConfigField("String", "CONTINUUM_URL", "\"${continuumUrl}/?room=${roomCode}\"")
        buildConfigField("String", "ROOM_CODE", "\"${roomCode}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
