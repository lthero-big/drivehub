plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.drivehub.app"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.drivehub.app"
        minSdk = 26
        targetSdk = 35
        // Synced from /VERSION by scripts/bump-version.sh (verified by scripts/check-version.sh).
        versionCode = 101
        versionName = "0.1.1"
        // Major API contract version this app speaks (server API_VERSION).
        buildConfigField("int", "API_VERSION", "1")
    }

    // Release signing comes from CI secrets (see .github/workflows/release.yml). Without them the
    // release APK is signed with the local debug key so it stays installable (NOT for stores).
    val ksFile = System.getenv("DRIVEHUB_KEYSTORE_FILE")
    signingConfigs {
        if (!ksFile.isNullOrBlank()) {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("DRIVEHUB_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DRIVEHUB_KEY_ALIAS")
                keyPassword = System.getenv("DRIVEHUB_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (!ksFile.isNullOrBlank()) signingConfigs.getByName("release")
            else signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.isIncludeAndroidResources = true
        unitTests.all { t ->
            // Layout screenshots (Robolectric + Roborazzi) are opt-in: ./gradlew testDebugUnitTest -Pscreenshots
            if (project.hasProperty("screenshots")) {
                t.systemProperty("roborazzi.test.record", "true")
                t.maxHeapSize = "2g"
            } else t.exclude("**/ScreenshotTest*")
        }
    }
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(bom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.4.1")
    // RHEA-279: thumbnails (memory/disk LRU, down-sampling, video frames) and media colour sampling.
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("io.coil-kt:coil-video:2.7.0")
    implementation("androidx.palette:palette-ktx:1.0.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.32.2")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.32.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
