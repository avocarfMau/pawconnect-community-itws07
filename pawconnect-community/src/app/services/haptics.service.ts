import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/**
 * Centralized, best-effort haptic feedback for important resident actions.
 * Haptics must never prevent a user action from completing.
 */
@Injectable({ providedIn: 'root' })
export class HapticsService {
  private readonly supportedPlatform = Capacitor.isNativePlatform();

  private async safelyRun(action: () => Promise<void>): Promise<void> {
    if (!this.supportedPlatform) return;

    try {
      await action();
    } catch {
      // Unsupported devices, disabled haptics, or plugin errors should be silent.
    }
  }

  /** For meaningful navigation or a refresh gesture. */
  light(): Promise<void> {
    return this.safelyRun(() => Haptics.impact({ style: ImpactStyle.Light }));
  }

  /** For submitting a report, adoption request, or confirming an action. */
  medium(): Promise<void> {
    return this.safelyRun(() => Haptics.impact({ style: ImpactStyle.Medium }));
  }

  /** Reserve for especially consequential confirmations. */
  heavy(): Promise<void> {
    return this.safelyRun(() => Haptics.impact({ style: ImpactStyle.Heavy }));
  }

  /** After the backend confirms an action succeeded. */
  success(): Promise<void> {
    return this.safelyRun(() =>
      Haptics.notification({ type: NotificationType.Success })
    );
  }

  /** For validation failures or failed requests. */
  error(): Promise<void> {
    return this.safelyRun(() =>
      Haptics.notification({ type: NotificationType.Error })
    );
  }

  /** For destructive actions or warnings requiring attention. */
  warning(): Promise<void> {
    return this.safelyRun(() =>
      Haptics.notification({ type: NotificationType.Warning })
    );
  }

  /** For intentional selections, not every routine tap. */
  selection(): Promise<void> {
    return this.safelyRun(() => Haptics.selectionChanged());
  }
}
