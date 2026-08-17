package attest.selfverify;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The Android half of the Attest self verification fixture.
 *
 * It talks to the same HTTP fixture the web scenario drives, so the same
 * Postgres delta assertions hold on both surfaces. It is deliberately native
 * rather than a WebView: a WebView exposes a degraded accessibility tree with
 * no resource ids, which would make the Android locator work look like it
 * succeeded while it was really matching on text alone.
 */
public final class MainActivity extends Activity {

  /** Intent extra Attest passes so the app can find the ephemeral fixture port. */
  private static final String EXTRA_API_BASE = "attest_api_base";

  /** 10.0.2.2 is the emulator's alias for the host loopback interface. */
  private static final String DEFAULT_API_BASE = "http://10.0.2.2:8080";

  private static final String CREATE_ORDER_BODY =
      "{\"customerId\":\"cust_a\",\"orderId\":\"order_300\",\"status\":\"created\","
          + "\"totalCents\":9900,\"items\":["
          + "{\"sku\":\"new_lamp\",\"quantity\":2,\"unitCents\":3000},"
          + "{\"sku\":\"new_shade\",\"quantity\":1,\"unitCents\":3900}]}";

  private static final String CUSTOMER_ROW_MARKER = "data-testid=\"customer-row\"";
  private static final String DELETE_CUSTOMER_ID = "cust_c";

  private String apiBase = DEFAULT_API_BASE;
  private TextView customerList;
  private TextView statusText;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    apiBase = resolveApiBase(getIntent());
    setContentView(buildLayout());
    loadCustomers();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    apiBase = resolveApiBase(intent);
    loadCustomers();
  }

  /**
   * The fixture server binds an ephemeral port, so the base URL cannot be
   * baked in. Attest passes it as a string extra on every activity start.
   */
  private String resolveApiBase(Intent intent) {
    if (intent != null) {
      String extra = intent.getStringExtra(EXTRA_API_BASE);
      if (extra != null && extra.length() > 0) {
        return extra;
      }

      Uri data = intent.getData();
      if (data != null) {
        String fromQuery = data.getQueryParameter(EXTRA_API_BASE);
        if (fromQuery != null && fromQuery.length() > 0) {
          return fromQuery;
        }
      }
    }

    return apiBase;
  }

  private View buildLayout() {
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(32, 96, 32, 32);

    customerList = new TextView(this);
    customerList.setId(R.id.customer_list);
    customerList.setText("loading");
    customerList.setTextSize(22);
    root.addView(customerList, params());

    Button createOrder = new Button(this);
    createOrder.setId(R.id.create_order_action);
    createOrder.setText("Create order");
    createOrder.setContentDescription("create order");
    createOrder.setOnClickListener(
        new View.OnClickListener() {
          @Override
          public void onClick(View view) {
            createOrder();
          }
        });
    root.addView(createOrder, params());

    Button deleteCustomer = new Button(this);
    deleteCustomer.setId(R.id.delete_customer_action);
    deleteCustomer.setText("Delete customer");
    deleteCustomer.setContentDescription("delete customer");
    deleteCustomer.setOnClickListener(
        new View.OnClickListener() {
          @Override
          public void onClick(View view) {
            deleteCustomer();
          }
        });
    root.addView(deleteCustomer, params());

    statusText = new TextView(this);
    statusText.setId(R.id.status_text);
    statusText.setText("idle");
    statusText.setTextSize(20);
    root.addView(statusText, params());

    return root;
  }

  private LinearLayout.LayoutParams params() {
    return new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
  }

  private void loadCustomers() {
    setStatus("loading");
    run(
        new Work() {
          @Override
          public void run() throws Exception {
            Response response = request("GET", apiBase + "/", null);
            final String label =
                response.code == 200
                    ? countOccurrences(response.body, CUSTOMER_ROW_MARKER) + " customers"
                    : "customers unavailable";
            setCustomerList(label);
            setStatus(response.code == 200 ? "ready" : "load failed " + response.code);
          }
        });
  }

  private void createOrder() {
    setStatus("creating");
    run(
        new Work() {
          @Override
          public void run() throws Exception {
            Response response = request("POST", apiBase + "/orders", CREATE_ORDER_BODY);
            setStatus(response.code == 201 ? "order created" : "create failed " + response.code);
          }
        });
  }

  private void deleteCustomer() {
    setStatus("deleting");
    run(
        new Work() {
          @Override
          public void run() throws Exception {
            Response response =
                request("POST", apiBase + "/customers/" + DELETE_CUSTOMER_ID + "/delete", "");
            boolean ok = response.code == 303 || response.code == 200;
            setStatus(ok ? "customer deleted" : "delete failed " + response.code);
            if (ok) {
              loadCustomers();
            }
          }
        });
  }

  /**
   * Android forbids network on the main thread, so every call runs on its own
   * thread and every view update hops back.
   */
  private void run(final Work work) {
    new Thread(
            new Runnable() {
              @Override
              public void run() {
                try {
                  work.run();
                } catch (Exception error) {
                  setStatus("error " + error.getClass().getSimpleName());
                }
              }
            })
        .start();
  }

  private void setStatus(final String value) {
    runOnUiThread(
        new Runnable() {
          @Override
          public void run() {
            statusText.setText(value);
          }
        });
  }

  private void setCustomerList(final String value) {
    runOnUiThread(
        new Runnable() {
          @Override
          public void run() {
            customerList.setText(value);
          }
        });
  }

  private static int countOccurrences(String haystack, String needle) {
    int count = 0;
    int index = haystack.indexOf(needle);
    while (index != -1) {
      count += 1;
      index = haystack.indexOf(needle, index + needle.length());
    }
    return count;
  }

  private static Response request(String method, String url, String body) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    try {
      connection.setRequestMethod(method);
      connection.setConnectTimeout(10000);
      connection.setReadTimeout(10000);
      connection.setInstanceFollowRedirects(false);

      if (body != null) {
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        OutputStream output = connection.getOutputStream();
        try {
          output.write(payload);
        } finally {
          output.close();
        }
      }

      int code = connection.getResponseCode();
      return new Response(code, readAll(streamFor(connection, code)));
    } finally {
      connection.disconnect();
    }
  }

  private static InputStream streamFor(HttpURLConnection connection, int code) throws Exception {
    return code >= 400 ? connection.getErrorStream() : connection.getInputStream();
  }

  private static String readAll(InputStream stream) throws Exception {
    if (stream == null) {
      return "";
    }

    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    int read = stream.read(chunk);
    while (read != -1) {
      buffer.write(chunk, 0, read);
      read = stream.read(chunk);
    }
    stream.close();
    return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
  }

  private interface Work {
    void run() throws Exception;
  }

  private static final class Response {
    final int code;
    final String body;

    Response(int code, String body) {
      this.code = code;
      this.body = body;
    }
  }
}
