package app.bimmerlink.mybmw;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class CryptoHelper {
    public static final class Identity {
        public final String pairCode;
        public final byte[] aesKey;
        public final String stateTopic;

        public Identity(String pairCode, byte[] aesKey, String stateTopic) {
            this.pairCode = pairCode;
            this.aesKey = aesKey;
            this.stateTopic = stateTopic;
        }
    }

    public static Identity derive(String rawCode) {
        if (rawCode == null) return null;
        String clean = rawCode.trim();
        int hashIdx = clean.indexOf('#');
        if (hashIdx >= 0) clean = clean.substring(hashIdx + 1);
        int qIdx = clean.indexOf("k=");
        if (qIdx >= 0) {
            clean = clean.substring(qIdx + 2);
            int amp = clean.indexOf('&');
            if (amp >= 0) clean = clean.substring(0, amp);
        }
        if (clean.length() < 20) return null;
        try {
            byte[] seed = Base64.decode(clean, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            if (seed.length < 16) return null;

            MessageDigest mdKey = MessageDigest.getInstance("SHA-256");
            mdKey.update("BL-AES-KEY:".getBytes(StandardCharsets.UTF_8));
            byte[] aesKey = mdKey.digest(seed);

            MessageDigest mdTopic = MessageDigest.getInstance("SHA-256");
            mdTopic.update("BL-TOPIC:".getBytes(StandardCharsets.UTF_8));
            byte[] topicBytes = mdTopic.digest(seed);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 10; i++) {
                sb.append(String.format("%02x", topicBytes[i] & 0xff));
            }
            return new Identity(clean, aesKey, "bl_st_" + sb.toString());
        } catch (Exception e) {
            return null;
        }
    }

    public static String decryptPacket(byte[] aesKey, String wire) {
        if (wire == null || !wire.startsWith("BL2:")) return null;
        try {
            byte[] raw = Base64.decode(wire.substring(4), Base64.DEFAULT);
            if (raw.length < 28) return null;
            byte[] iv = Arrays.copyOfRange(raw, 0, 12);
            byte[] body = Arrays.copyOfRange(raw, 12, raw.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(aesKey, "AES"), new GCMParameterSpec(128, iv));
            byte[] plain = cipher.doFinal(body);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
