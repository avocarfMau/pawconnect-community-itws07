<?php

// =====================================
// PAWRESCUE COMMUNITY
// GET COMMUNITY PET REPORTS
// =====================================

// CORS is automatically handled by
// cors.php through .htaccess.

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// RESPONSE HELPER
// =====================================

function sendReportsResponse(
    int $status,
    array $data
): void {

    http_response_code($status);

    echo json_encode($data);

    exit;
}

// =====================================
// VALIDATE REQUEST METHOD
// =====================================

// OPTIONS requests are already handled
// by the centralized cors.php.

if ($_SERVER["REQUEST_METHOD"] !== "GET") {

    header("Allow: GET, OPTIONS");

    sendReportsResponse(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

// =====================================
// LOAD AUTHENTICATION MIDDLEWARE
// =====================================

require_once __DIR__ .
    "/../middleware/auth_middleware.php";

try {

    // =====================================
    // AUTHENTICATE RESIDENT OR STAFF
    // =====================================

    $auth = authenticate([
        "resident",
        "staff"
    ]);

    $conn = $auth["connection"];

    // =====================================
    // VALIDATE REPORT FILTER
    // =====================================

    $reportType =
        $_GET["type"] ?? "all";

    if (
        !is_string($reportType) ||
        !in_array(
            $reportType,
            ["all", "lost", "found"],
            true
        )
    ) {

        sendReportsResponse(400, [
            "success" => false,
            "message" => "Invalid report filter."
        ]);
    }

    // =====================================
    // RETRIEVE COMMUNITY REPORTS
    // =====================================

    $sql = "
        SELECT
            p.id,
            p.report_type,
            p.animal_type,
            p.pet_name,
            p.description,
            p.photo_path,
            p.incident_date,
            p.location_address,
            p.latitude,
            p.longitude,
            p.status,
            p.created_at,
            u.full_name AS reporter_name
        FROM pet_reports p
        INNER JOIN users u
            ON u.id = p.user_id
        WHERE p.report_type IN ('lost', 'found')
            AND p.status NOT IN ('resolved', 'closed')
    ";

    $params = [];

    // =====================================
    // OPTIONAL TYPE FILTER
    // =====================================

    if ($reportType !== "all") {

        $sql .= "
            AND p.report_type = :report_type
        ";

        $params[":report_type"] =
            $reportType;
    }

    // =====================================
    // SORT NEWEST REPORTS FIRST
    // =====================================

    $sql .= "
        ORDER BY
            p.created_at DESC,
            p.id DESC
        LIMIT 100
    ";

    // =====================================
    // EXECUTE QUERY
    // =====================================

    $stmt = $conn->prepare($sql);

    $stmt->execute($params);

    $reports = $stmt->fetchAll(
        PDO::FETCH_ASSOC
    );

    // =====================================
    // INITIALIZE MULTIPLE-PHOTO FIELDS
    // =====================================

    // Keep photo_path for compatibility with
    // existing pages that display one image.
    // The photos array holds all report photos.

    $reportIds = [];
    $reportIndexes = [];

    foreach ($reports as $index => &$report) {

        $reportId = (int) $report["id"];

        $reportIds[] = $reportId;
        $reportIndexes[$reportId] = $index;

        $report["photos"] = [];
        $report["photo_count"] = 0;
    }

    unset($report);

    // =====================================
    // RETRIEVE ALL PHOTOS FOR THESE REPORTS
    // =====================================

    // One additional query retrieves photos for
    // all reports, avoiding one query per report.

    if (!empty($reportIds)) {

        $placeholders = implode(
            ", ",
            array_fill(0, count($reportIds), "?")
        );

        $photoSql = "
            SELECT
                id,
                report_id,
                photo_path,
                sort_order,
                created_at
            FROM pet_report_photos
            WHERE report_id IN ($placeholders)
            ORDER BY
                report_id ASC,
                sort_order ASC,
                id ASC
        ";

        $photoStmt = $conn->prepare($photoSql);

        foreach ($reportIds as $position => $reportId) {

            $photoStmt->bindValue(
                $position + 1,
                $reportId,
                PDO::PARAM_INT
            );
        }

        $photoStmt->execute();

        while ($photo = $photoStmt->fetch(PDO::FETCH_ASSOC)) {

            $reportId = (int) $photo["report_id"];

            if (!isset($reportIndexes[$reportId])) {
                continue;
            }

            $index = $reportIndexes[$reportId];

            $reports[$index]["photos"][] = [
                "id" => (int) $photo["id"],
                "photo_path" => $photo["photo_path"],
                "sort_order" => (int) $photo["sort_order"],
                "created_at" => $photo["created_at"]
            ];

            $reports[$index]["photo_count"]++;

            // Use the first photo as the legacy
            // cover image when photo_path is empty.
            if (empty($reports[$index]["photo_path"])) {
                $reports[$index]["photo_path"] =
                    $photo["photo_path"];
            }
        }
    }

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    sendReportsResponse(200, [
        "success" => true,
        "message" => "Reports retrieved successfully.",
        "count" => count($reports),
        "reports" => $reports
    ]);

} catch (Throwable $e) {

    error_log(
        "[PawRescue Get Reports Error] " .
        $e->getMessage()
    );

    sendReportsResponse(500, [
        "success" => false,
        "message" => "Unable to retrieve reports."
    ]);
}
