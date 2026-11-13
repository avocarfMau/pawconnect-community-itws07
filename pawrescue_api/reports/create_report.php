
<?php

// =====================================
// PAWRESCUE COMMUNITY
// CREATE LOST OR FOUND PET REPORT
// AUTO-CREATE ASSISTANCE REFERRALS FOR FLAGGED FOUND PETS
// =====================================

// CORS is automatically handled by
// cors.php through .htaccess.

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// RESPONSE HELPER
// =====================================

function sendResponse(
    $status,
    $success,
    $message,
    $extra = []
) {
    http_response_code($status);

    echo json_encode(array_merge([
        "success" => $success,
        "message" => $message
    ], $extra));

    exit;
}

// =====================================
// PERFORMANCE MONITORING
// =====================================

$requestStart = microtime(true);

function logPerformance(
    $stage,
    $startTime
) {
    $elapsed = round(
        (microtime(true) - $startTime) * 1000,
        2
    );

    error_log(
        "[PawRescue Performance] " .
        $stage . ": " .
        $elapsed . " ms"
    );
}

// =====================================
// VALIDATE REQUEST METHOD
// =====================================

// OPTIONS requests are already
// handled by centralized cors.php.

if ($_SERVER["REQUEST_METHOD"] !== "POST") {

    header("Allow: POST, OPTIONS");

    sendResponse(
        405,
        false,
        "Method not allowed."
    );
}

// =====================================
// LOAD AUTHENTICATION
// =====================================

require_once __DIR__ .
    "/../middleware/auth_middleware.php";

// =====================================
// VALIDATE CONTENT TYPE
// =====================================

if (
    stripos(
        $_SERVER["CONTENT_TYPE"] ?? "",
        "application/json"
    ) === false
) {
    sendResponse(
        415,
        false,
        "Content-Type must be application/json."
    );
}

try {

    // =====================================
    // AUTHENTICATE RESIDENT
    // =====================================

    $authStart = microtime(true);

    $auth = authenticate(["resident"]);

    $conn = $auth["connection"];
    $userId = (int) $auth["user"]["id"];

    logPerformance(
        "Authentication",
        $authStart
    );

    // =====================================
    // READ REQUEST DATA
    // =====================================

    $validationStart = microtime(true);

    $data = json_decode(
        file_get_contents("php://input"),
        true
    );

    if (
        !is_array($data) ||
        array_is_list($data)
    ) {
        sendResponse(
            400,
            false,
            "Invalid JSON request."
        );
    }

    // =====================================
    // REQUIRED FIELDS
    // =====================================

    $required = [
        "report_type",
        "animal_type",
        "description",
        "incident_date",
        "location_address"
    ];

    foreach ($required as $field) {

        if (
            !isset($data[$field]) ||
            !is_string($data[$field]) ||
            trim($data[$field]) === ""
        ) {
            sendResponse(
                400,
                false,
                "Please complete all required fields."
            );
        }
    }

    // =====================================
    // EXTRACT DATA
    // =====================================

    $reportType = trim(
        $data["report_type"]
    );

    $animalType = trim(
        $data["animal_type"]
    );

    $description = trim(
        $data["description"]
    );

    $incidentDate = trim(
        $data["incident_date"]
    );

    $location = trim(
        $data["location_address"]
    );

    $petName = $data["pet_name"] ?? null;
    $latitude = $data["latitude"] ?? null;
    $longitude = $data["longitude"] ?? null;

    // =====================================
    // ANIMAL ASSISTANCE DATA (FOUND PET ONLY)
    // =====================================
    // These optional fields are sent only when the resident selects
    // "Yes, needs assistance" on the Found Pet form.

    $needsAssistance = $data["needs_assistance"] ?? false;
    $assistanceReason = $data["assistance_reason"] ?? null;
    $assistanceDetails = $data["assistance_details"] ?? null;

    // =====================================
    // VALIDATE REPORT TYPE
    // =====================================

    if (!in_array(
        $reportType,
        ["lost", "found"],
        true
    )) {
        sendResponse(
            400,
            false,
            "Invalid report type."
        );
    }

    // =====================================
    // VALIDATE ANIMAL TYPE
    // =====================================

    if (!in_array(
        $animalType,
        ["dog", "cat"],
        true
    )) {
        sendResponse(
            400,
            false,
            "Invalid animal type."
        );
    }

    // =====================================
    // VALIDATE TEXT LENGTHS
    // =====================================

    if (
        mb_strlen($description) > 5000 ||
        mb_strlen($location) > 255
    ) {
        sendResponse(
            400,
            false,
            "Description or location is too long."
        );
    }

    // =====================================
    // VALIDATE OPTIONAL PET NAME
    // =====================================

    if ($petName !== null) {

        if (
            !is_string($petName) ||
            mb_strlen($petName) > 100
        ) {
            sendResponse(
                400,
                false,
                "Invalid pet name."
            );
        }

        $petName = trim($petName);

        if ($petName === "") {
            $petName = null;
        }
    }

    // =====================================
    // VALIDATE INCIDENT DATE
    // =====================================

    $incidentTimezone = new DateTimeZone("Asia/Manila");

    $date = DateTimeImmutable::createFromFormat(
        "!Y-m-d",
        $incidentDate,
        $incidentTimezone
    );

    if (
        !$date ||
        $date->format("Y-m-d") !== $incidentDate
    ) {
        sendResponse(
            400,
            false,
            "Invalid incident date."
        );
    }

    if (
        $date > new DateTimeImmutable("today", $incidentTimezone)
    ) {
        sendResponse(
            400,
            false,
            "Incident date cannot be in the future."
        );
    }

    // =====================================
    // VALIDATE GPS COORDINATES
    // =====================================

    // Latitude and longitude must both
    // be provided or both be null.

    if (
        ($latitude === null) !==
        ($longitude === null)
    ) {
        sendResponse(
            400,
            false,
            "Both coordinates are required."
        );
    }

    if ($latitude !== null) {

        if (
            !is_numeric($latitude) ||
            !is_numeric($longitude) ||
            !is_finite((float) $latitude) ||
            !is_finite((float) $longitude) ||
            (float) $latitude < -90 ||
            (float) $latitude > 90 ||
            (float) $longitude < -180 ||
            (float) $longitude > 180
        ) {
            sendResponse(
                400,
                false,
                "Invalid coordinates."
            );
        }
    }

    // =====================================
    // VALIDATE ANIMAL ASSISTANCE INFORMATION
    // =====================================

    // Do not accept truthy strings such as "false" or "yes".
    // The Angular app sends a real JSON boolean when assistance is requested.
    if (!is_bool($needsAssistance)) {
        sendResponse(400, false, "Invalid animal assistance selection.");
    }

    if (
        $assistanceReason !== null &&
        !is_string($assistanceReason)
    ) {
        sendResponse(400, false, "Invalid assistance reason.");
    }

    if (
        $assistanceDetails !== null &&
        !is_string($assistanceDetails)
    ) {
        sendResponse(400, false, "Invalid assistance details.");
    }

    $assistanceReason = $assistanceReason !== null
        ? trim($assistanceReason)
        : null;

    $assistanceDetails = $assistanceDetails !== null
        ? trim($assistanceDetails)
        : null;

    $assistanceReason = $assistanceReason === ''
        ? null
        : $assistanceReason;

    $assistanceDetails = $assistanceDetails === ''
        ? null
        : $assistanceDetails;

    if ($needsAssistance) {

        if ($reportType !== 'found') {
            sendResponse(
                400,
                false,
                "Animal assistance can only be requested for Found Pet reports."
            );
        }

        $allowedAssistanceReasons = [
            'injured',
            'sick',
            'trapped',
            'aggressive',
            'abandoned',
            'roaming',
            'other'
        ];

        if (
            $assistanceReason === null ||
            !in_array($assistanceReason, $allowedAssistanceReasons, true)
        ) {
            sendResponse(
                400,
                false,
                "Please select a valid animal assistance reason."
            );
        }

        if (
            $assistanceDetails !== null &&
            mb_strlen($assistanceDetails) > 1000
        ) {
            sendResponse(
                400,
                false,
                "Assistance details must be 1000 characters or fewer."
            );
        }

        if (
            $assistanceReason === 'other' &&
            $assistanceDetails === null
        ) {
            sendResponse(
                400,
                false,
                "Please describe the assistance needed when selecting Other concern."
            );
        }

        // Found Pet's assistance referral needs a usable incident location.
        // This does not change existing requirements for ordinary pet reports.
        if ($latitude === null || $longitude === null) {
            sendResponse(
                400,
                false,
                "GPS coordinates are required for an animal assistance request."
            );
        }

    } elseif ($assistanceReason !== null || $assistanceDetails !== null) {
        // Prevent clients from smuggling assistance information into a
        // Lost Pet report or a Found Pet report marked "No assistance".
        sendResponse(
            400,
            false,
            "Assistance details require selecting Needs Animal Assistance."
        );
    }

    logPerformance(
        "Validation",
        $validationStart
    );

    // =====================================
    // INSERT PET REPORT INTO DATABASE
    // =====================================

    $databaseStart = microtime(true);

    // The Found Pet report and its assistance case are one atomic operation.
    // If the new assistance table is missing or its insert fails, both inserts
    // are rolled back; we never claim that an incomplete referral was saved.
    $conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $conn->beginTransaction();

    $stmt = $conn->prepare(
        "INSERT INTO pet_reports
        (
            user_id,
            report_type,
            animal_type,
            pet_name,
            description,
            incident_date,
            location_address,
            latitude,
            longitude,
            status
        )
        VALUES
        (
            :user_id,
            :report_type,
            :animal_type,
            :pet_name,
            :description,
            :incident_date,
            :location_address,
            :latitude,
            :longitude,
            'pending'
        )"
    );

    $stmt->execute([
        ":user_id" => $userId,
        ":report_type" => $reportType,
        ":animal_type" => $animalType,
        ":pet_name" => $petName,
        ":description" => $description,
        ":incident_date" => $incidentDate,
        ":location_address" => $location,
        ":latitude" => $latitude,
        ":longitude" => $longitude
    ]);

    $reportId = (int) $conn->lastInsertId();

    $assistanceCaseId = null;

    if ($needsAssistance) {
        // Requires the animal_assistance_cases table created by our next
        // database migration, including UNIQUE(found_report_id).
        // Staff manage this case separately from the Found Pet report.
        $caseStmt = $conn->prepare(
            "INSERT INTO animal_assistance_cases
            (
                found_report_id,
                assistance_reason,
                assistance_details,
                status
            )
            VALUES
            (
                :found_report_id,
                :assistance_reason,
                :assistance_details,
                'pending'
            )"
        );

        $caseStmt->execute([
            ':found_report_id' => $reportId,
            ':assistance_reason' => $assistanceReason,
            ':assistance_details' => $assistanceDetails
        ]);

        $assistanceCaseId = (int) $conn->lastInsertId();
    }

    $conn->commit();

    logPerformance(
        "Database Insert",
        $databaseStart
    );

    // =====================================
    // TOTAL PROCESSING TIME
    // =====================================

    logPerformance(
        "Total Request",
        $requestStart
    );

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    sendResponse(
        201,
        true,
        "Pet report submitted successfully!",
        [
            "report_id" => $reportId,
            "assistance_requested" => $needsAssistance,
            "assistance_case_id" => $assistanceCaseId
        ]
    );

} catch (Throwable $e) {

    if (isset($conn) && $conn instanceof PDO && $conn->inTransaction()) {
        try {
            $conn->rollBack();
        } catch (Throwable $rollbackError) {
            error_log(
                "[PawRescue Create Report Rollback Error] " .
                $rollbackError->getMessage()
            );
        }
    }

    error_log(
        "[PawRescue Create Report Error] " .
        $e->getMessage()
    );

    logPerformance(
        "Failed Request",
        $requestStart
    );

    sendResponse(
        500,
        false,
        "Unable to submit report. Please try again."
    );
}
