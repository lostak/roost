plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.lostak.roost"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.lostak.roost"
        minSdk = 29
        targetSdk = 35
        // CI sets the build number, so every published APK is a higher version than the last.
        versionCode = (System.getenv("ROOST_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("ROOST_VERSION_NAME") ?: "dev"
        buildConfigField("String", "UPDATE_URL", "\"https://github.com/lostak/roost/releases/download/android/version.json\"")
    }
    // One fixed signing key so every build installs over the last one (Android refuses an update
    // signed with a different key). See android/README.md.
    signingConfigs {
        create("roost") {
            storeFile = rootProject.file("roost.keystore")
            storePassword = "roost-android"
            keyAlias = "roost"
            keyPassword = "roost-android"
        }
    }
    buildTypes {
        debug { signingConfig = signingConfigs.getByName("roost") }
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("roost") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
