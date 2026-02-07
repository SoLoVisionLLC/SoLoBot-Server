package ai.openclaw.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

object ChatNotificationHelper {
  private const val CHANNEL_ID = "chat_replies"
  private const val CHANNEL_NAME = "Chat Replies"
  private const val NOTIF_ID = 8421

  fun notifyReply(context: Context, title: String, text: String) {
    val mgr = context.getSystemService(NotificationManager::class.java)
    if (mgr != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        CHANNEL_NAME,
        NotificationManager.IMPORTANCE_DEFAULT,
      )
      mgr.createNotificationChannel(channel)
    }

    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pending = PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(text.take(200))
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setContentIntent(pending)
      .setAutoCancel(true)
      .build()

    mgr?.notify(NOTIF_ID, notification)
  }
}
