<?php
/**
 * Plugin Name: Seating Mail Relay
 * Description: Authenticated mail bridge for Seating Studio test messages and self check-in codes.
 * Version: 1.2.0
 */

if (!defined('ABSPATH')) {
    exit;
}

const SEATING_STUDIO_RELAY_SECRET_FILE = '/var/www/seating.example.com/.seating-studio-mail-relay.secret';
const SEATING_STUDIO_RELAY_MAX_CLOCK_DRIFT = 300;
const SEATING_STUDIO_RELAY_ASSET_DIR = '/var/www/seating.example.com/htdocs/wp-content/mu-plugins/seating-studio-mail-assets';

function seating_studio_relay_error($code, $message, $status) {
    return new WP_Error($code, $message, array('status' => $status));
}

function seating_studio_relay_secret() {
    if (!is_readable(SEATING_STUDIO_RELAY_SECRET_FILE)) {
        return '';
    }

    $secret = trim((string) file_get_contents(SEATING_STUDIO_RELAY_SECRET_FILE));
    return strlen($secret) >= 32 ? $secret : '';
}

function seating_studio_relay_inline_assets($requested, $kind) {
    if (!is_array($requested)) {
        return array();
    }
    if ($kind !== 'campaign-test' || count($requested) > 2) {
        return seating_studio_relay_error('invalid_payload', 'Invalid inline assets.', 400);
    }

    $library = array(
        'header' => array('path' => SEATING_STUDIO_RELAY_ASSET_DIR . '/header.jpg', 'cid' => 'seating-studio-header', 'name' => 'seating-studio-header.jpg', 'mime' => 'image/jpeg'),
        'footer' => array('path' => SEATING_STUDIO_RELAY_ASSET_DIR . '/footer.jpg', 'cid' => 'seating-studio-footer', 'name' => 'seating-studio-footer.jpg', 'mime' => 'image/jpeg'),
    );
    $assets = array();
    foreach ($requested as $key) {
        $key = is_string($key) ? $key : '';
        if (!isset($library[$key]) || isset($assets[$key]) || !is_readable($library[$key]['path'])) {
            return seating_studio_relay_error('invalid_payload', 'Inline asset is unavailable.', 400);
        }
        $assets[$key] = $library[$key];
    }
    return array_values($assets);
}

function seating_studio_relay_authorize(WP_REST_Request $request) {
    $secret = seating_studio_relay_secret();
    if ($secret === '') {
        return seating_studio_relay_error('relay_unavailable', 'Mail relay unavailable.', 503);
    }

    $timestamp = (string) $request->get_header('x-seating-studio-timestamp');
    $nonce = strtolower((string) $request->get_header('x-seating-studio-nonce'));
    $signature = strtolower((string) $request->get_header('x-seating-studio-signature'));
    if (!preg_match('/^\d{10}$/', $timestamp) || abs(time() - (int) $timestamp) > SEATING_STUDIO_RELAY_MAX_CLOCK_DRIFT) {
        return seating_studio_relay_error('invalid_timestamp', 'Request authentication failed.', 401);
    }
    if (!preg_match('/^[a-f0-9]{32}$/', $nonce) || !preg_match('/^[a-f0-9]{64}$/', $signature)) {
        return seating_studio_relay_error('invalid_signature', 'Request authentication failed.', 401);
    }

    $expected = hash_hmac('sha256', $timestamp . '.' . $nonce . '.' . $request->get_body(), $secret);
    if (!hash_equals($expected, $signature)) {
        return seating_studio_relay_error('invalid_signature', 'Request authentication failed.', 401);
    }

    $nonce_key = 'seating_studio_relay_' . hash('sha256', $nonce);
    if (get_transient($nonce_key)) {
        return seating_studio_relay_error('replayed_request', 'Request authentication failed.', 409);
    }
    set_transient($nonce_key, '1', 10 * MINUTE_IN_SECONDS);

    return true;
}

function seating_studio_relay_send(WP_REST_Request $request) {
    $authorized = seating_studio_relay_authorize($request);
    if (is_wp_error($authorized)) {
        return $authorized;
    }

    $payload = $request->get_json_params();
    $kind = is_array($payload) ? (string) ($payload['kind'] ?? '') : '';
    if (!in_array($kind, array('campaign-test', 'self-checkin-code'), true)) {
        return seating_studio_relay_error('invalid_payload', 'Invalid mail request.', 400);
    }

    $to = sanitize_email((string) ($payload['to'] ?? ''));
    $reply_to = sanitize_email((string) ($payload['replyTo'] ?? ''));
    $subject = sanitize_text_field((string) ($payload['subject'] ?? ''));
    $html = (string) ($payload['html'] ?? '');
    $text = (string) ($payload['text'] ?? '');
    $calendar = (string) ($payload['calendar'] ?? '');
    $inline_assets = seating_studio_relay_inline_assets($payload['inlineAssets'] ?? array(), $kind);
    if (is_wp_error($inline_assets)) {
        return $inline_assets;
    }

    $valid_subject = $kind === 'campaign-test'
        ? strpos($subject, '[TEST] ') === 0
        : preg_match('/^Your check-in code: [0-9]{6}$/', $subject) === 1;
    if (!is_email($to) || ($reply_to !== '' && !is_email($reply_to)) || !$valid_subject) {
        return seating_studio_relay_error('invalid_payload', 'Invalid mail request.', 400);
    }
    if ($subject === '' || strlen($subject) > 220 || $html === '' || strlen($html) > 300000 || strlen($text) > 100000 || strlen($calendar) > 32768) {
        return seating_studio_relay_error('invalid_payload', 'Mail content is outside the allowed limits.', 400);
    }

    $headers = array('Content-Type: text/html; charset=UTF-8');
    $headers[] = $kind === 'campaign-test' ? 'X-Seating-Studio-Campaign-Test: true' : 'X-Seating-Studio-Self-Check-In: verification';
    if ($reply_to !== '') {
        $headers[] = 'Reply-To: ' . $reply_to;
    }

    $attachments = array();
    $calendar_path = '';
    if ($calendar !== '' && $kind === 'campaign-test') {
        $temp_path = wp_tempnam('event');
        $calendar_path = $temp_path ? $temp_path . '.ics' : '';
        if ($temp_path && !rename($temp_path, $calendar_path)) {
            $calendar_path = $temp_path;
        }
        if ($calendar_path && file_put_contents($calendar_path, $calendar, LOCK_EX) !== false) {
            $attachments[] = $calendar_path;
        }
    }

    $embed_callback = null;
    if (!empty($inline_assets)) {
        $embed_callback = function ($phpmailer) use ($inline_assets) {
            foreach ($inline_assets as $asset) {
                $phpmailer->addEmbeddedImage($asset['path'], $asset['cid'], $asset['name'], 'base64', $asset['mime']);
            }
        };
        add_action('phpmailer_init', $embed_callback);
    }

    try {
        $sent = wp_mail($to, $subject, $html, $headers, $attachments);
    } finally {
        if ($embed_callback) {
            remove_action('phpmailer_init', $embed_callback);
        }
        if ($calendar_path && file_exists($calendar_path)) {
            unlink($calendar_path);
        }
    }

    if (!$sent) {
        return seating_studio_relay_error('delivery_failed', 'The configured mail provider did not accept the message.', 502);
    }

    return rest_ensure_response(array(
        'sent' => true,
        'messageId' => 'wordpress-' . wp_generate_uuid4(),
    ));
}

add_action('rest_api_init', function () {
    register_rest_route('seating-studio/v1', '/send-test', array(
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'seating_studio_relay_send',
        'permission_callback' => '__return_true',
    ));
});
