package app.konso;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.view.DisplayCutout;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The whole Android side of Konso.
 *
 * The app itself is a web page (assets/www: index.html, app.js, app.css, i18n.js, parse.js) shown in a
 * WebView. This activity:
 * - serves those files from a tiny HTTP server on 127.0.0.1 (a real http:// origin is needed for
 *   localStorage and for the WebAssembly and web worker of the OCR engine);
 * - refuses every request to any other host, so the app does not use the internet, with one
 *   exception the user turns on in the Stations tab: the official French fuel price site
 *   (PRICES_HOST), and only that one;
 * - opens the camera or the gallery when the page asks for a receipt photo (input type="file");
 * - gives the page a small bridge, window.Android (class Bridge), to choose a backup folder and to
 *   read / write konso.json in it through the Storage Access Framework (works with Google Drive too);
 * - colours the status bar and the navigation bar like the page (light or dark theme), so the app
 *   looks like it fills the whole screen (Bridge.setBars()), and in landscape lets the page draw
 *   next to the camera cutout instead of leaving a black band (drawBehindBars(), fitBars(),
 *   Bridge.insets()).
 */
public class MainActivity extends Activity {

    private static final String HOST = "127.0.0.1";
    /**
     * Fixed port: the page's origin (http://127.0.0.1:38917) stays the same between launches, and so
     * does its localStorage. If the port is taken, any free port is used.
     */
    private static final int PREFERRED_PORT = 38917;
    private static final String FILE_NAME = "konso.json";
    /** Test build (APK of a branch, app id app.konso.test): its own port and file, so it never touches the real app's data. */
    private static final int TEST_PORT = 38918;
    private static final String TEST_FILE_NAME = "konso-test.json";
    /** Preference holding the chosen backup folder (a content:// tree URI). */
    private static final String PREF_TREE = "tree_uri";
    /**
     * The only internet host the page may reach: the official French fuel price feed
     * (data.economie.gouv.fr), used by the Stations tab. Allowed only over https and only while the
     * user has turned on "Allow the connection for stations" (preference PREF_ONLINE, set by the
     * page through Bridge.setOnline()).
     */
    private static final String PRICES_HOST = "data.economie.gouv.fr";
    private static final String PREF_ONLINE = "online";
    /** Last colours of the system bars sent by the page, applied again at the next launch. */
    private static final String PREF_BARS = "bars";
    /** Request codes of startActivityForResult(). */
    private static final int REQ_FOLDER = 1;
    private static final int REQ_IMAGE = 2;

    private WebView web;
    /** Holds the WebView; its padding keeps the page clear of the system bars (fitBars()). */
    private FrameLayout root;
    /** Room taken by the camera cutout on the left and right edges, in CSS pixels ("left,right"). */
    private volatile String cutout = "0,0";
    private SharedPreferences prefs;
    private ServerSocket server;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    /** Pending answer to the page's file input (receipt photo). */
    private ValueCallback<Uri[]> chooserCallback;
    /** Where the camera writes the photo, when the user chooses the camera. */
    private Uri cameraUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("konso", MODE_PRIVATE);

        int port;
        try {
            port = startServer();
        } catch (IOException e) {
            port = -1;
        }

        // In landscape the camera cutout is on a short edge: draw the page there too (the page keeps
        // its content clear of the cutout, see Bridge.insets()) instead of a black band. Letting
        // the window reach the cutout is not enough: Android would still pad the content by the
        // cutout, showing the (black) window background. So the app lays itself out behind the
        // system bars and keeps clear of the bars only (fitBars()), not of the cutout.
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        getWindow().setAttributes(lp);
        drawBehindBars();

        web = new WebView(this);
        root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        // the colours of the last launch, so the bars match the page before it has loaded. Only
        // once the content is set: before that the window has no decor view yet, and on recent
        // Android versions asking for its insets controller then crashes the app.
        String bars = prefs.getString(PREF_BARS, null);
        if (bars != null) {
            String[] b = bars.split(",");
            if (b.length == 3) applyBars(b[0], b[1], "1".equals(b[2]));
        }
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                readCutout(insets);
                return fitBars(v, insets);
            }
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);

        web.addJavascriptInterface(new Bridge(), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Only the app itself (the local server) may be loaded: any other host is refused,
                // so the app has no internet access, except the official fuel price site when the
                // user has allowed it in the Stations tab.
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) {
                    return null;
                }
                if (PRICES_HOST.equals(url.getHost()) && "https".equals(url.getScheme())
                        && prefs.getBoolean(PREF_ONLINE, false)) {
                    return null;
                }
                return emptyResponse(403, "Forbidden");
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Links to other sites are not opened.
                return !HOST.equals(request.getUrl().getHost());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (chooserCallback != null) {
                    chooserCallback.onReceiveValue(null);
                }
                chooserCallback = callback;
                return launchImageChooser();
            }
        });

        if (port < 0) {
            web.loadData("<html><body><p>Local server could not start. Please restart the app.</p></body></html>",
                    "text/html", "utf-8");
        } else if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl("http://" + HOST + ":" + port + "/index.html");
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    // ------------------------------------------------------------------
    // Interface files (assets/www) served by a small local HTTP server on 127.0.0.1
    // ------------------------------------------------------------------

    /** APKs built from a branch have the id "app.konso.test" (see app/build.gradle). */
    private boolean isTestBuild() {
        return getPackageName().endsWith(".test");
    }

    /**
     * Name of the backup file: konso.json, or konso-test.json for a test build.
     */
    private String saveFileName() {
        return isTestBuild() ? TEST_FILE_NAME : FILE_NAME;
    }

    /**
     * Start the server on a background thread and return its port. Each connection is handled by the pool.
     */
    private int startServer() throws IOException {
        InetAddress lo = InetAddress.getByName(HOST);
        try {
            server = new ServerSocket(isTestBuild() ? TEST_PORT : PREFERRED_PORT, 20, lo);
        } catch (IOException busy) {
            server = new ServerSocket(0, 20, lo);
        }
        final ServerSocket ss = server;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                while (!ss.isClosed()) {
                    try {
                        final Socket client = ss.accept();
                        pool.execute(new Runnable() {
                            @Override
                            public void run() {
                                handle(client);
                            }
                        });
                    } catch (Exception e) {
                        break;
                    }
                }
            }
        }, "assets-server");
        t.setDaemon(true);
        t.start();
        return ss.getLocalPort();
    }

    /**
     * Answer one HTTP request: GET or HEAD of a file of assets/www, nothing else.
     */
    private void handle(Socket client) {
        try {
            client.setSoTimeout(10000);
            BufferedReader r = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), StandardCharsets.ISO_8859_1));
            String line = r.readLine();
            if (line == null) return;
            String h;
            while ((h = r.readLine()) != null && !h.isEmpty()) {
                // headers are not needed
            }
            String[] parts = line.split(" ");
            String method = parts[0];
            String target = parts.length > 1 ? parts[1] : "/";
            int q = target.indexOf('?');
            if (q >= 0) target = target.substring(0, q);
            int f = target.indexOf('#');
            if (f >= 0) target = target.substring(0, f);
            OutputStream out = client.getOutputStream();
            boolean head = method.equals("HEAD");
            if (!head && !method.equals("GET")) {
                respond(out, 405, "Method Not Allowed", "text/plain", new byte[0], false);
                return;
            }
            if (target.isEmpty() || target.equals("/")) target = "/index.html";
            // .gz files are stored as ".gz.bin": otherwise the Android build tools strip the .gz
            // extension from assets and unpack the file (used by the French OCR model).
            // A path containing ".." is refused, so only files under www/ can be read.
            String assetName = "www" + target + (target.endsWith(".gz") ? ".bin" : "");
            byte[] body = target.contains("..") ? null : readAsset(assetName);
            if (body == null) {
                respond(out, 404, "Not Found", "text/plain", new byte[0], head);
            } else {
                respond(out, 200, "OK", mimeFor(target), body, head);
            }
        } catch (Exception ignored) {
        } finally {
            try {
                client.close();
            } catch (IOException ignored) {
            }
        }
    }

    /**
     * Content of a file of the APK assets, or null if it does not exist.
     */
    private byte[] readAsset(String name) {
        try {
            InputStream in = getAssets().open(name);
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            } finally {
                in.close();
            }
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * Write an HTTP response. head = headers only (HEAD request).
     */
    private static void respond(OutputStream out, int code, String reason, String mime, byte[] body,
                                boolean head) throws IOException {
        boolean text = mime.startsWith("text/") || mime.equals("application/json");
        String hdr = "HTTP/1.1 " + code + " " + reason + "\r\n"
                + "Content-Type: " + mime + (text ? "; charset=utf-8" : "") + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-cache\r\n"
                + "Connection: close\r\n\r\n";
        out.write(hdr.getBytes(StandardCharsets.ISO_8859_1));
        if (!head) out.write(body);
        out.flush();
    }

    /**
     * Empty answer, used to refuse requests to other hosts.
     */
    private static WebResourceResponse emptyResponse(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason,
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    /**
     * Content type from the file extension.
     */
    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".gz")) return "application/gzip";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------
    // Receipt photo: camera or gallery
    // ------------------------------------------------------------------

    /**
     * Ask the user for a picture: a chooser offering the gallery and, when possible, the camera.
     * With the camera, the photo is written to a new entry of the phone's pictures (cameraUri).
     */
    private boolean launchImageChooser() {
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("image/*");
        Intent chooser = Intent.createChooser(pick, null);

        cameraUri = null;
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Images.Media.DISPLAY_NAME, "ticket_" + System.currentTimeMillis() + ".jpg");
            v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            if (cameraUri != null) {
                Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
            }
        } catch (Exception e) {
            cameraUri = null; // camera not available: gallery only
        }

        try {
            startActivityForResult(chooser, REQ_IMAGE);
            return true;
        } catch (Exception e) {
            if (chooserCallback != null) {
                chooserCallback.onReceiveValue(null);
                chooserCallback = null;
            }
            deleteCameraEntry();
            return false;
        }
    }

    /**
     * Remove the empty picture entry prepared for the camera when it was not used.
     */
    private void deleteCameraEntry() {
        if (cameraUri != null) {
            try {
                getContentResolver().delete(cameraUri, null, null);
            } catch (Exception ignored) {
            }
            cameraUri = null;
        }
    }

    /** Results of the photo chooser (REQ_IMAGE) and of the folder picker (REQ_FOLDER). */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_IMAGE) {
            if (chooserCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK) {
                if (data != null && data.getData() != null) {
                    result = new Uri[]{data.getData()};
                    deleteCameraEntry(); // picture chosen in the gallery: the camera entry is not needed
                } else if (cameraUri != null) {
                    result = new Uri[]{cameraUri};
                    cameraUri = null;
                }
            }
            if (result == null) {
                deleteCameraEntry();
            }
            chooserCallback.onReceiveValue(result);
            chooserCallback = null;
            return;
        }

        if (requestCode == REQ_FOLDER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri tree = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(tree,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    prefs.edit().putString(PREF_TREE, tree.toString()).apply();
                } catch (Exception e) {
                    // the permission could not be kept: the folder cannot be used
                    prefs.edit().remove(PREF_TREE).apply();
                }
            }
            // Tell the page (app.js: window.onFolderPicked) which folder is now used ('' if none).
            final String name = JSONObject.quote(folderDisplayName());
            web.post(new Runnable() {
                @Override
                public void run() {
                    web.evaluateJavascript("window.onFolderPicked && window.onFolderPicked(" + name + ")", null);
                }
            });
        }
    }

    // ------------------------------------------------------------------
    // System bars (status bar at the top, navigation bar at the bottom)
    // ------------------------------------------------------------------

    /**
     * Colour the status bar with top and the navigation bar with bottom ("#rrggbb", the page's
     * colours), with dark or light icons: dark = the page uses its dark theme, so the icons
     * (clock, battery, gesture bar) are drawn light. Must run on the UI thread.
     */
    private void applyBars(String top, String bottom, boolean dark) {
        try {
            Window w = getWindow();
            w.getDecorView(); // makes sure the decor view exists (getInsetsController() needs it)
            w.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                    | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
            w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            w.setStatusBarColor(Color.parseColor(top));
            w.setNavigationBarColor(Color.parseColor(bottom));
            // the window background shows wherever the page does not reach (it is black in the
            // device theme): give it the page's colour, so no black band can appear
            w.setBackgroundDrawable(new ColorDrawable(Color.parseColor(top)));
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    c.setSystemBarsAppearance(dark ? 0 : light, light);
                }
            } else {
                View d = w.getDecorView();
                int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                int f = d.getSystemUiVisibility();
                d.setSystemUiVisibility(dark ? (f & ~light) : (f | light));
            }
        } catch (IllegalArgumentException e) {
            // not a colour: the bars keep their current colours
        } catch (RuntimeException e) {
            // the colours of the bars are only cosmetic: never let them stop the app
        }
    }

    /**
     * Lay the window out behind the status bar and the navigation bar: the app then decides itself
     * how much room to leave them (fitBars()), and Android no longer pads the content by the camera
     * cutout. The bars keep their colours (applyBars()), drawn over the room left for them.
     */
    private void drawBehindBars() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
        } else {
            View d = w.getDecorView();
            d.setSystemUiVisibility(d.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    /**
     * Pad v (the WebView's frame) by the room the status bar, the navigation bar and the keyboard
     * take, but not by the camera cutout: the page itself keeps clear of the cutout (Bridge.insets()).
     * The keyboard is counted too, as adjustResize no longer shrinks a window laid out behind the
     * bars. Returns the insets left for the WebView, without the bars and the keyboard, so the page
     * does not keep clear of them a second time.
     */
    private WindowInsets fitBars(View v, WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= 30) {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return new WindowInsets.Builder(insets)
                    .setInsets(WindowInsets.Type.systemBars(), Insets.NONE)
                    .setInsets(WindowInsets.Type.ime(), Insets.NONE)
                    .build();
        }
        // Android 10: the system window insets may also count the cutout; leave that part out
        DisplayCutout c = insets.getDisplayCutout();
        int cl = c == null ? 0 : c.getSafeInsetLeft(),
                cr = c == null ? 0 : c.getSafeInsetRight();
        v.setPadding(Math.max(0, insets.getSystemWindowInsetLeft() - cl), insets.getSystemWindowInsetTop(),
                Math.max(0, insets.getSystemWindowInsetRight() - cr), insets.getSystemWindowInsetBottom());
        return insets.replaceSystemWindowInsets(0, 0, 0, 0);
    }

    /**
     * Keep the room taken by the camera cutout on the left and right edges (landscape), in CSS
     * pixels, and tell the page (app.js: window.onInsets) so it moves its content clear of it.
     * The top and bottom are left out: there the status and navigation bars already keep clear.
     */
    private void readCutout(WindowInsets insets) {
        DisplayCutout c = insets.getDisplayCutout();
        float d = getResources().getDisplayMetrics().density;
        String now = c == null ? "0,0"
                : Math.round(c.getSafeInsetLeft() / d) + "," + Math.round(c.getSafeInsetRight() / d);
        if (now.equals(cutout)) return;
        cutout = now;
        web.evaluateJavascript("window.onInsets && window.onInsets()", null);
    }

    // ------------------------------------------------------------------
    // Chosen folder (Storage Access Framework) and backup file
    // ------------------------------------------------------------------

    /** The chosen folder, only if the app may still read and write it. */
    private Uri treeUri() {
        String s = prefs.getString(PREF_TREE, null);
        if (s == null) return null;
        Uri tree = Uri.parse(s);
        List<UriPermission> perms = getContentResolver().getPersistedUriPermissions();
        for (UriPermission p : perms) {
            if (p.getUri().equals(tree) && p.isReadPermission() && p.isWritePermission()) {
                return tree;
            }
        }
        return null;
    }

    /**
     * Name of the chosen folder as shown to the user ('' if none).
     */
    private String folderDisplayName() {
        Uri tree = treeUri();
        if (tree == null) return "";
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        Cursor c = null;
        try {
            c = getContentResolver().query(doc,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        String last = tree.getLastPathSegment();
        return last == null ? "?" : last;
    }

    /** The backup file directly inside the chosen folder, or null. */
    private Uri findJsonFile(Uri tree) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree,
                DocumentsContract.getTreeDocumentId(tree));
        Cursor c = null;
        try {
            c = getContentResolver().query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            while (c != null && c.moveToNext()) {
                String n = c.getString(1);
                if (saveFileName().equals(n)) {
                    return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    /** Name of the backup file actually used in the folder (shown in Settings). */
    private String currentFileName() {
        Uri tree = treeUri();
        if (tree == null) return saveFileName();
        Uri file = findJsonFile(tree);
        if (file == null) return saveFileName();
        Cursor c = null;
        try {
            c = getContentResolver().query(file,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return saveFileName();
    }

    /**
     * Write the backup file (created if needed, otherwise overwritten).
     * Returns "ok", or the reason of the failure, which the page shows to the user.
     */
    private String writeJson(String text) {
        Uri tree = treeUri();
        if (tree == null) return "no folder access";
        try {
            Uri file = findJsonFile(tree);
            if (file == null) {
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree,
                        DocumentsContract.getTreeDocumentId(tree));
                file = DocumentsContract.createDocument(getContentResolver(), parent,
                        "application/json", saveFileName());
            }
            if (file == null) return "cannot create file";
            OutputStream os = getContentResolver().openOutputStream(file, "wt");
            if (os == null) return "cannot open file";
            try {
                os.write(text.getBytes(StandardCharsets.UTF_8));
                os.flush();
            } finally {
                os.close();
            }
            return "ok";
        } catch (Exception e) {
            return e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage());
        }
    }

    /**
     * Content of the backup file, or '' if there is none.
     */
    private String readJson() {
        Uri tree = treeUri();
        if (tree == null) return "";
        try {
            Uri file = findJsonFile(tree);
            if (file == null) return "";
            InputStream in = getContentResolver().openInputStream(file);
            if (in == null) return "";
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Methods the page can call (app.js, NA): window.Android.folderName(), pickFolder(),
     * writeFile(text), fileName(), readFile(), setOnline(on), setBars(top, bottom, dark) and insets().
     */
    public class Bridge {
        @JavascriptInterface
        public String folderName() {
            return folderDisplayName();
        }

        @JavascriptInterface
        public void pickFolder() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_FOLDER);
                    } catch (Exception e) {
                        web.evaluateJavascript("window.onFolderPicked && window.onFolderPicked('')", null);
                    }
                }
            });
        }

        @JavascriptInterface
        public String writeFile(String text) {
            return writeJson(text == null ? "" : text);
        }

        @JavascriptInterface
        public String fileName() {
            return currentFileName();
        }

        @JavascriptInterface
        public String readFile() {
            return readJson();
        }

        /**
         * The switch "Allow the connection for stations" of the Stations tab: while it is on, the
         * page may reach PRICES_HOST (see shouldInterceptRequest); off, nothing leaves the phone.
         */
        @JavascriptInterface
        public void setOnline(boolean on) {
            prefs.edit().putBoolean(PREF_ONLINE, on).apply();
        }

        /** Room taken by the camera cutout on the left and right edges, in CSS pixels: "left,right". */
        @JavascriptInterface
        public String insets() {
            return cutout;
        }

        /**
         * Colours of the system bars, sent by the page each time its theme changes: top = colour
         * of the top of the page, bottom = colour of its navigation bar, dark = dark theme. They are
         * kept for the next launch.
         */
        @JavascriptInterface
        public void setBars(final String top, final String bottom, final boolean dark) {
            if (top == null || bottom == null) return;
            prefs.edit().putString(PREF_BARS, top + "," + bottom + "," + (dark ? "1" : "0")).apply();
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applyBars(top, bottom, dark);
                }
            });
        }
    }
}
