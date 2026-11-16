import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LostFoundPage } from './lost-found.page';

describe('LostFoundPage', () => {
  let component: LostFoundPage;
  let fixture: ComponentFixture<LostFoundPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(LostFoundPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
